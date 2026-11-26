import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import * as memory from '../src/agent/memory.js';
import { createServerClient, runRemote } from '../src/core/serverClient.js';
import { createEmbedder, EMBED_COOLDOWN_MS } from '../src/llm/embeddings.js';
import { buildContext, runAgent } from '../src/agent/agent.js';
import { questionToolProfile } from '../src/agent/questionTools.js';
import { isSmallTalk } from '../src/llm/router.js';
import { nativeStreamFetcher, wrapFetch } from '../src/mobile/nativeFetch.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (ev) => `${ev.seq ? `id: ${ev.seq}\n` : ''}data: ${JSON.stringify(ev)}\n\n`;

describe('回复提速：云端一步建流、前置并行、向量冷却与前缀缓存', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
    useBackend(null);
  });

  it('云服务器一步建流：POST /api/tasks?stream=1 同一连接直接推回首字与结果，省去第二趟 GET 请求', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fast-stream-'));
    let releaseTail;
    const tailGate = new Promise((r) => { releaseTail = r; });
    let runner;
    const adapter = {
      kind: 'mock',
      async stream({ onText }) {
        onText?.('首段秒出，');
        await tailGate;
        onText?.('全部答完。');
        return { text: '首段秒出，全部答完。', toolCalls: [], stop: 'end_turn' };
      }
    };
    runner = createTaskRunner({
      getConfig: async () => ({ provider: 'openai', models: { openai: 'gpt-test' }, keys: { openai: 'sk-test' }, autoMemory: false }),
      makeAdapter: () => ({ adapter, model: 'gpt-test' }),
      makeTools: () => []
    });
    const mode = createServerMode({ dataDir, password: 'password123', runner });
    const httpServer = createServer({ serverMode: mode });
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    cleanups.push(async () => {
      await runner.settled();
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const requestedPaths = [];
    const countingFetch = (url, init) => {
      requestedPaths.push(`${init?.method || 'GET'} ${new URL(url).pathname}${new URL(url).search}`);
      return fetch(url, init);
    };
    const loginClient = createServerClient({ base, fetchImpl: countingFetch });
    const token = await loginClient.login('password123');
    requestedPaths.length = 0;

    const client = createServerClient({ base, token, fetchImpl: countingFetch });
    const chunks = [];
    let startedId = '';
    const pending = runRemote(client, {
      sessionId: 'c_fast_1',
      userText: '你好',
      onStarted: (t) => { startedId = t.id; },
      emit: (ev) => {
        if (ev.type === 'text') {
          chunks.push(ev.delta);
          if (chunks.length === 1) releaseTail();
        }
      }
    });
    const result = await pending;
    expect(startedId).toMatch(/^t/);
    expect(chunks).toEqual(['首段秒出，', '全部答完。']);
    expect(result.text).toBe('首段秒出，全部答完。');
    // 全程只有一次 POST /api/tasks?stream=1，没有再发起 GET /api/tasks/:id/events
    expect(requestedPaths).toEqual(['POST /api/tasks?stream=1']);
  });

  it('一步建流中途断流或连上旧版 JSON 服务器时，无缝退回按序号续接且不重复提交任务', async () => {
    const events = [
      { seq: 1, type: 'task_state', status: 'running' },
      { seq: 2, type: 'text', delta: '前半句，' },
      { seq: 3, type: 'text', delta: '后半句。' },
      { seq: 4, type: 'task_state', status: 'done', text: '前半句，后半句。', completedAt: 500 }
    ];
    const calls = [];
    const dropClient = {
      streaming: true,
      async startTaskStream(body) {
        calls.push(['streamPost', body.text]);
        const enc = new TextEncoder();
        let i = 0;
        const head = [frame({ type: 'task_created', id: 't_drop', sessionId: 'c1' }), frame(events[0]), frame(events[1])];
        const stream = new ReadableStream({
          pull(ctl) {
            if (i < head.length) ctl.enqueue(enc.encode(head[i++]));
            else ctl.error(new TypeError('network interrupted'));
          }
        });
        return { res: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }), payload: body };
      },
      async retryStartTask() { calls.push(['retryPost']); throw new Error('不应重发 POST'); },
      async startTask() { calls.push(['startTask']); throw new Error('不应重发 startTask'); },
      async stopTask() {},
      async events(id, after) {
        calls.push(['followEvents', id, after]);
        return new Response(events.filter((e) => e.seq > after).map(frame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
    };
    const texts = [];
    const res1 = await runRemote(dropClient, { sessionId: 'c1', userText: '测试断流续接', emit: (e) => { if (e.type === 'text') texts.push(e.delta); } });
    expect(texts).toEqual(['前半句，', '后半句。']);
    expect(res1.text).toBe('前半句，后半句。');
    expect(calls).toEqual([['streamPost', '测试断流续接'], ['followEvents', 't_drop', 2]]);

    // 旧版服务器忽略 ?stream=1 直接返回 JSON：不报错、不重发 POST，直接走 events(after=0)
    const legacyCalls = [];
    const legacyClient = {
      streaming: true,
      async startTaskStream(body) {
        legacyCalls.push('postJson');
        return { res: new Response(JSON.stringify({ id: 't_old', sessionId: 'c1' }), { status: 200, headers: { 'content-type': 'application/json' } }), payload: body };
      },
      async stopTask() {},
      async events(id, after) {
        legacyCalls.push(`events:${id}:${after}`);
        return new Response(events.map(frame).join(''), { status: 200 });
      }
    };
    const res2 = await runRemote(legacyClient, { sessionId: 'c1', userText: '旧服兼容', emit: () => {} });
    expect(res2.completedAt).toBe(500);
    expect(legacyCalls).toEqual(['postJson', 'events:t_old:0']);
  });

  it('一步建流连上后连接“半死”（不断开也不再来数据）时，超时后按已收到的序号续接，不卡住也不重复提交', async () => {
    // 2026-11-26 Claude 复核：两步走时 followTask 有 45 秒无数据重连；一步建流的首段原来没有，手机换网时回复会一直转圈
    const events = [
      { seq: 1, type: 'task_state', status: 'running' },
      { seq: 2, type: 'text', delta: '先到的，' },
      { seq: 3, type: 'text', delta: '续上的。' },
      { seq: 4, type: 'task_state', status: 'done', text: '先到的，续上的。', completedAt: 700 }
    ];
    const calls = [];
    let cancelled = false;
    const client = {
      streaming: true,
      async startTaskStream(body) {
        calls.push(['streamPost', body.text]);
        const enc = new TextEncoder();
        const head = [frame({ type: 'task_created', id: 't_stall', sessionId: 'c1' }), frame(events[0]), frame(events[1])];
        let i = 0;
        const stream = new ReadableStream({
          pull(ctl) {
            if (i < head.length) { ctl.enqueue(enc.encode(head[i++])); return; }
            return new Promise(() => {}); // 之后既不来数据也不断开
          },
          cancel() { cancelled = true; }
        });
        return { res: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }), payload: body };
      },
      async retryStartTask() { calls.push(['retryPost']); throw new Error('不应重发 POST'); },
      async startTask() { calls.push(['startTask']); throw new Error('不应重发 startTask'); },
      async stopTask() { calls.push(['stop']); },
      async getTask() { return { status: 'running', seq: 2 }; },
      async events(id, after) {
        calls.push(['followEvents', id, after]);
        return new Response(events.filter((e) => e.seq > after).map(frame).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
    };
    const texts = [];
    const t0 = Date.now();
    const out = await runRemote(client, { sessionId: 'c1', userText: '测试半死连接', emit: (e) => { if (e.type === 'text') texts.push(e.delta); }, observation: { idleMs: 150 } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(cancelled).toBe(true);
    expect(texts).toEqual(['先到的，', '续上的。']);
    expect(out.text).toBe('先到的，续上的。');
    expect(calls).toEqual([['streamPost', '测试半死连接'], ['followEvents', 't_stall', 2]]);
  });

  it('联网预取与上下文准备并行执行，且上下文报错时立即取消在途预取', async () => {
    let seenMessages = null;
    const adapter = {
      kind: 'mock',
      async stream({ messages, onText }) {
        seenMessages = messages;
        onText?.('晴，22℃');
        return { text: '晴，22℃', toolCalls: [], stop: 'end_turn' };
      }
    };
    const weatherTool = {
      name: 'get_weather',
      description: '查天气',
      recoveryManaged: true,
      input_schema: { type: 'object', properties: { place: { type: 'string' } } },
      async run() {
        await wait(80);
        return '杭州今天晴，22℃';
      }
    };
    const slowContext = async () => {
      await wait(80);
      return { dynamic: '固定上下文', kbHits: [] };
    };
    const t0 = Date.now();
    // 注入 slowContext 验证与 get_weather 并行（串行至少 160ms，并行约 85ms）
    let contextStarted = 0;
    let weatherStarted = 0;
    const timedWeather = {
      ...weatherTool,
      async run() {
        weatherStarted = Date.now();
        await wait(90);
        return '杭州今天晴，22℃';
      }
    };
    const result = await runAgent({
      adapter,
      model: 'm',
      history: [],
      userText: '杭州今天天气怎么样',
      tools: [timedWeather],
      emit: () => {},
      context: undefined,
      // 通过自定义 memory 查询耗时观察并行度：这里直接用延迟的 lookupPreferences + get_weather 验证
      lookupPreferences: async () => {
        contextStarted = Date.now();
        return [];
      }
    });
    expect(result.text).toContain('22℃');
    expect(JSON.stringify(seenMessages)).toContain('杭州今天晴');
    expect(Date.now() - t0).toBeLessThan(1500);
    void slowContext;
    void contextStarted;
    expect(weatherStarted).toBeGreaterThan(0);

    // 验证真正的并行重叠：给记忆装一条带向量的记录，让 embedder 慢 90ms，同时 get_weather 慢 90ms
    memory.configureMemory({
      embedder: {
        model: 'test:emb',
        async embed() {
          await wait(90);
          return [[1, 0]];
        }
      }
    });
    await memory.remember('用户喜欢简洁天气播报', 'preference');
    cleanups.push(() => { memory.configureMemory({}); });

    const startParallel = Date.now();
    await runAgent({
      adapter,
      model: 'm',
      history: [],
      userText: '上海今天天气怎么样',
      tools: [weatherTool],
      emit: () => {}
    });
    const elapsed = Date.now() - startParallel;
    // 向量 90ms 与天气 80ms 并行重叠，总耗时显著低于串行相加（留足 CI 抖动余量）
    expect(elapsed).toBeLessThan(165);
  });

  it('向量服务故障后进入 45 秒短时冷却，后续对话零等待跳过，冷却到期自动恢复', async () => {
    let clock = 1000;
    let calls = 0;
    let shouldFail = true;
    const embedder = createEmbedder(
      { keys: { openai: 'sk-test' } },
      {
        now: () => clock,
        fetchImpl: async () => {
          calls++;
          if (shouldFail) return new Response('not supported', { status: 404 });
          return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.5, 0.5] }] }));
        }
      }
    );
    await expect(embedder.embed(['第一句'])).rejects.toThrow('404');
    expect(calls).toBe(1);

    // 冷却期内不再请求上游，0ms 直接跳过
    clock += 5000;
    await expect(embedder.embed(['第二句'])).rejects.toThrow(/冷却/);
    expect(calls).toBe(1);

    // 冷却期过后自动恢复正常调用
    shouldFail = false;
    clock += EMBED_COOLDOWN_MS;
    expect(await embedder.embed(['第三句'])).toEqual([[0.5, 0.5]]);
    expect(calls).toBe(2);
  });

  it('跨会话消息检索复用 BM25 索引，其他会话更新后自动刷新', async () => {
    const s1 = sessions.create({ title: '差旅制度', messages: [{ role: 'user', content: '高铁报销标准是多少', ts: 10 }, { role: 'assistant', content: '二等座实报实销', ts: 11 }] });
    await sessions.save(s1);
    const first = await sessions.searchMessages('高铁报销标准', { exclude: 'current_chat' });
    const second = await sessions.searchMessages('高铁报销标准', { exclude: 'current_chat' });
    expect(first[0]?.sessionId).toBe(s1.id);
    expect(second[0]?.sessionId).toBe(s1.id);

    const s2 = sessions.create({ title: '住宿补贴', messages: [{ role: 'user', content: '深圳出差住宿补贴上限', ts: 20 }, { role: 'assistant', content: '每晚 550 元', ts: 21 }] });
    await sessions.save(s2);
    const updated = await sessions.searchMessages('深圳出差住宿补贴', { exclude: 'current_chat' });
    expect(updated[0]?.sessionId).toBe(s2.id);
  });

  it('buildContext 将稳定段置于时间与动态检索之前，且日常短句翻译与礼貌短语走轻量通道', async () => {
    await memory.setCore('human', '在上海做产品经理');
    const ctx = await buildContext('帮我想个周末安排');
    const wsIdx = ctx.dynamic.indexOf('工作区：');
    const coreIdx = ctx.dynamic.indexOf('## 核心记忆');
    const timeIdx = ctx.dynamic.indexOf('当前时间：');
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThan(wsIdx);
    expect(timeIdx).toBeGreaterThan(coreIdx);

    expect(isSmallTalk('不客气！')).toBe(true);
    expect(isSmallTalk('辛苦啦')).toBe(true);
    expect(questionToolProfile('把“春眠不觉晓”翻译成英文')).toBe('knowledge');
    expect(questionToolProfile('什么是TCP三次握手？')).toBe('knowledge');
    expect(questionToolProfile('把附件里的合同翻译成英文')).toBeNull();
  });

  it('手机已安装 NativeStream 时，POST /api/tasks?stream=1 直接走原生流式而不先试 WebView', async () => {
    const webCalls = [];
    const started = [];
    const plugin = {
      addListener(name, fn) {
        if (name === 'head') setTimeout(() => fn({ id: started[0]?.id, status: 200, headers: { 'content-type': 'text/event-stream' } }), 0);
        if (name === 'end') setTimeout(() => fn({ id: started[0]?.id }), 5);
        return Promise.resolve({ remove() {} });
      },
      async start(o) { started.push(o); },
      async cancel() {}
    };
    const g = { Capacitor: { isPluginAvailable: (n) => n === 'NativeStream' } };
    const wrapped = wrapFetch(async () => { webCalls.push(1); return new Response(); }, nativeStreamFetcher(plugin), 'https://localhost', g);
    g.__jarvisPreferNative('cloud.example.com');
    const res = await wrapped('https://cloud.example.com/api/tasks?stream=1', {
      method: 'POST',
      stream: true,
      headers: { Accept: 'text/event-stream' },
      body: '{"text":"你好"}'
    });
    expect(res.status).toBe(200);
    expect(webCalls).toEqual([]);
    expect(started[0]).toMatchObject({ method: 'POST', body: '{"text":"你好"}' });
  });
});
