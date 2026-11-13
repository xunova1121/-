import { describe, it, expect } from 'vitest';
import { parseSse, followTask, runRemote, normalizeUrl, loadServerSettings, saveServerSettings, remoteSessions } from '../src/core/serverClient.js';

const frame = (ev) => `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
/** 假服务器：第一次连接发两条就断，之后从 after 接着发到结束 */
function fakeClient(all, { dropAfter = 2 } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    stopped: false,
    async startTask(o) { calls.push(['start', o]); return { id: 't1', sessionId: o.sessionId }; },
    async stopTask() { this.stopped = true; },
    async events(id, after) {
      calls.push(['events', after]);
      const rest = all.filter((e) => e.seq > after);
      const first = n++ === 0;
      const part = first ? rest.slice(0, dropAfter) : rest;
      const enc = new TextEncoder();
      let i = 0;
      const body = new ReadableStream({ pull(c) { if (i < part.length) c.enqueue(enc.encode(frame(part[i++]))); else if (first) c.error(new TypeError('network')); else c.close(); } });
      return new Response(body, { status: 200 });
    }
  };
}
const EVENTS = [
  { seq: 1, type: 'task_state', status: 'running' },
  { seq: 2, type: 'text', delta: '第一段，' },
  { seq: 3, type: 'tool_start', id: 'a', name: 'create_document', args: {} },
  { seq: 4, type: 'file', path: '汇报.docx' },
  { seq: 5, type: 'text', delta: '做好了。' },
  { seq: 6, type: 'task_state', status: 'done', text: '第一段，做好了。', toolCalls: 1 }
];

describe('服务器模式客户端', () => {
  it('SSE 切分：不完整的留到下次', () => {
    const { events, rest } = parseSse(`${frame({ seq: 1, type: 'x' })}data: {"seq":2`);
    expect(events).toEqual([{ seq: 1, type: 'x' }]);
    expect(rest).toBe('data: {"seq":2');
  });
  it('网络断了自动重连，从断开的序号接着收，不重复', async () => {
    const c = fakeClient(EVENTS);
    const got = [];
    const end = await followTask(c, 't1', { onEvent: (e) => got.push(e.seq), retryMs: [1] });
    expect(got).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.calls.filter((x) => x[0] === 'events').map((x) => x[1])).toEqual([0, 2]);
    expect(end.status).toBe('done');
  });
  it('runRemote 和 runAgent 一样用：进度交给 emit，文件交给 onFile，返回回答', async () => {
    const c = fakeClient(EVENTS);
    const emitted = [];
    const files = [];
    const r = await runRemote(c, { sessionId: 'c1', userText: '做个汇报', emit: (e) => emitted.push(e.type), onFile: (p) => files.push(p) });
    expect(r).toMatchObject({ text: '第一段，做好了。', toolCalls: 1 });
    expect(emitted).toEqual(['text', 'tool_start', 'text']);
    expect(files).toEqual(['汇报.docx']);
    expect(c.calls[0]).toEqual(['start', { sessionId: 'c1', text: '做个汇报' }]);
  });
  it('中间网络卡住了最后的“完成”：问一下服务器，做完了就重连拿到结果', async () => {
    let n = 0;
    const c = {
      async getTask() { return { status: 'done', seq: 6 }; },
      async events(id, after) {
        n++;
        const enc = new TextEncoder();
        if (n === 1) return new Response(new ReadableStream({ start(ctl) { for (const e of EVENTS.slice(0, 5)) ctl.enqueue(enc.encode(frame(e))); } }), { status: 200 }); // 发到一半就不动了
        return new Response(EVENTS.filter((e) => e.seq > after).map(frame).join(''), { status: 200 });
      }
    };
    const end = await followTask(c, 't1', { checkMs: 30, retryMs: [1] });
    expect(end).toMatchObject({ status: 'done', text: '第一段，做好了。' });
    expect(n).toBe(2);
  });
  it('手机原生网络：要求事件流的 GET 也边收边显示', async () => {
    const { wantsStream } = await import('../src/mobile/nativeFetch.js');
    expect(wantsStream({ headers: { Accept: 'text/event-stream' } })).toBe(true);
    expect(wantsStream({})).toBe(false);
  });
  it('用户叫停：服务器上的任务也停下', async () => {
    const c = fakeClient(EVENTS, { dropAfter: 1 });
    c.events = async () => new Response(new ReadableStream({ start() {} }), { status: 200 }); // 一直不来新数据
    const ctrl = new AbortController();
    const p = runRemote(c, { sessionId: 'c1', userText: 'x', emit: () => {}, signal: ctrl.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    expect((await p).name).toBe('AbortError');
    expect(c.stopped).toBe(true);
  });
  it('服务器上的任务出错：报出原因', async () => {
    const c = fakeClient([{ seq: 1, type: 'task_state', status: 'error', error: '模型还没配置好' }]);
    c.events = async () => new Response(frame({ seq: 1, type: 'task_state', status: 'error', error: '模型还没配置好' }), { status: 200 });
    await expect(runRemote(c, { sessionId: 'c1', userText: 'x', emit: () => {} })).rejects.toThrow('模型还没配置好');
  });
  it('设置：网址补全 https，令牌保存，不存密码', () => {
    expect(normalizeUrl('d.leing.top/')).toBe('https://d.leing.top');
    expect(normalizeUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    const m = new Map();
    const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
    saveServerSettings({ url: 'https://d.leing.top', token: 'abc', enabled: true, password: '不该存' }, st);
    expect(loadServerSettings(st)).toEqual({ url: 'https://d.leing.top', token: 'abc', enabled: true });
    expect([...m.values()].join('')).not.toContain('不该存');
  });
  it('对话列表、改标题、删除都走服务器', async () => {
    const calls = [];
    const r = remoteSessions({ listSessions: async () => [{ id: 'c1', title: '三季度汇报' }, { id: 'c2', title: '周报' }], patchSession: async (...a) => calls.push(['patch', ...a]), deleteSession: async (id) => calls.push(['del', id]), getSession: async () => null });
    expect((await r.search('汇报')).map((s) => s.id)).toEqual(['c1']);
    await r.rename('c1', '新标题');
    await r.remove('c2');
    expect(calls).toEqual([['patch', 'c1', { title: '新标题' }], ['del', 'c2']]);
  });
});

describe('服务器模式：打开快、不卡住', () => {
  const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('网络卡住时超时报错；读数据的请求自动再试一次，并记下每次花了多久', async () => {
    let n = 0;
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
      n++;
      if (n === 1) { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); return; } // 第一次一直不回
      resolve(jsonRes([{ id: 'a', title: '甲' }]));
    });
    const { createServerClient } = await import('../src/core/serverClient.js');
    const c = createServerClient({ base: 'https://s.example', token: 't', fetchImpl, timeoutMs: 50 });
    expect(await c.listSessions()).toEqual([{ id: 'a', title: '甲' }]);
    expect(n).toBe(2);
    expect(c.timings.map((t) => t.ok)).toEqual([true, false]);
    // 一直卡住：两次都超时，报“超时”
    const stuck = createServerClient({ base: 'https://s.example', fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), timeoutMs: 30 });
    await expect(stuck.listSessions()).rejects.toThrow('超时');
    // 写数据的请求不重试（免得做两遍）
    let posts = 0;
    const once = createServerClient({ base: 'https://s.example', fetchImpl: (u, init) => { if(init.method==='POST')posts++; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }, timeoutMs: 30 });
    await expect(once.startTask({ text: 'x' })).rejects.toThrow('超时');
    expect(posts).toBe(1);
  });

  it('留一份副本：重新打开时马上有列表和对话内容；几处同时要列表只请求一次；删除后副本里也没了', async () => {
    const storage = memStorage();
    let lists = 0;
    const client = {
      listSessions: async () => { lists++; return [{ id: 'a', title: '甲', updatedAt: 2, count: 3, taskId: null }]; },
      getSession: async (id) => ({ id, title: '甲', updatedAt: 2, messages: [{ role: 'user', content: '你好' }] }),
      deleteSession: async () => ({ ok: true }), patchSession: async () => ({ ok: true })
    };
    const r = remoteSessions(client, { storage });
    expect(r.cachedList()).toBeNull();
    await Promise.all([r.list(), r.list(), r.list()]);
    expect(lists).toBe(1);
    await r.get('a');
    r.flush();
    // 模拟 App 关掉再打开：新建一个，副本还在
    const again = remoteSessions(client, { storage });
    expect(again.cachedList().map((x) => x.title)).toEqual(['甲']);
    expect(again.cachedGet('a')).toMatchObject({ id: 'a', cached: true, messages: [{ content: '你好' }] });
    await again.remove('a');
    again.flush();
    expect(remoteSessions(client, { storage }).cachedGet('a')).toBeNull();
    expect(remoteSessions(client, { storage }).cachedList()).toEqual([]);
  });
});

it('服务器支持去重时写请求重试保持同一编号；旧服务器不重试',async()=>{
 const {createServerClient}=await import('../src/core/serverClient.js');
 for(const supported of [true,false]){
  const payloads=[];const client=createServerClient({base:'https://example.test',fetchImpl:async(url,init)=>{
   if(url.endsWith('/api/server/status'))return new Response(JSON.stringify({features:{taskRequestIds:supported}}));
   payloads.push(JSON.parse(init.body));if(payloads.length===1)throw new TypeError('network');return new Response(JSON.stringify({id:'t'}));
  }});
  if(supported){await client.startTask({sessionId:'c',text:'运行'});expect(payloads).toHaveLength(2);expect(payloads[0].requestId).toBe(payloads[1].requestId);}
  else{await expect(client.startTask({sessionId:'c',text:'运行'})).rejects.toThrow('network');expect(payloads).toHaveLength(1);}
 }
});

it('提交尚未返回任务编号时叫停，拿到编号后立即停止服务器任务，不开始跟随',async()=>{
 let release;const events=[];const client={startTask:()=>new Promise(r=>{release=r}),stopTask:async id=>{events.push('stop:'+id)},events:async()=>{events.push('follow');}};
 const ctrl=new AbortController(),pending=runRemote(client,{sessionId:'c',userText:'做任务',signal:ctrl.signal,emit:()=>{}});ctrl.abort();release({id:'late'});
 await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(events).toEqual(['stop:late']);
});

describe('手机放久了再发：旧连接断了不白等', () => {
  it('发任务第一次几秒没回应就换新连接重发（服务器按请求编号去重），不等满 20 秒', async () => {
    const { createServerClient, FIRST_WRITE_MS } = await import('../src/core/serverClient.js');
    expect(FIRST_WRITE_MS).toBeLessThanOrEqual(8000);
    const ids = [];
    let posts = 0;
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
      if (String(url).endsWith('/api/server/status')) return resolve(new Response(JSON.stringify({ features: { taskRequestIds: true } })));
      posts++;
      ids.push(JSON.parse(init.body).requestId);
      if (posts === 1) { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); return; }
      resolve(new Response(JSON.stringify({ id: 't1', sessionId: 's1' })));
    });
    // 默认超时设得比“第一次等待”长，确认第一次用的是短的那个
    const c = createServerClient({ base: 'https://s.example', token: 't', fetchImpl, timeoutMs: 60_000 });
    const t0 = Date.now();
    const real = setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => real(fn, ms === FIRST_WRITE_MS ? 30 : ms, ...a);
    try {
      expect(await c.startTask({ text: '你好' })).toEqual({ id: 't1', sessionId: 's1' });
    } finally {
      globalThis.setTimeout = real;
    }
    expect(posts).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('唤醒连接 30 秒内只问一次', async () => {
    const { createServerClient } = await import('../src/core/serverClient.js');
    let health = 0;
    const c = createServerClient({ base: 'https://s.example', fetchImpl: async (url) => { if (String(url).endsWith('/api/health')) health++; return new Response('{}'); } });
    c.warm(); c.warm(); c.warm();
    await new Promise((r) => setTimeout(r, 20));
    expect(health).toBe(1);
  });
});

describe('边收边显示的路不通时自动退回', () => {
  const sse = (evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
  const hang = (signal) => new Response(new ReadableStream({ start(c) { signal?.addEventListener('abort', () => { try { c.error(new Error('aborted')); } catch { /* 已关 */ } }); } }), { status: 200 });

  it('边收边显示几秒收不到任何东西：改用一次给全的方式拿到回答，不会一直转圈', async () => {
    const calls = [];
    let streaming = true;
    const client = {
      get streaming() { return streaming; },
      streamFailed() { if (!streaming) return false; streaming = false; return true; },
      getTask: async () => ({ status: 'running', seq: 0 }),
      events: async (id, after, signal) => { calls.push(streaming ? 'stream' : 'whole'); return streaming ? hang(signal) : sse([{ seq: 1, type: 'text', delta: '你好' }, { seq: 2, type: 'task_state', status: 'done', text: '你好' }]); }
    };
    const got = [];
    const t0 = Date.now();
    const end = await followTask(client, 't1', { onEvent: (e) => got.push(e), firstMs: 50, retryMs: [10] });
    expect(end.status).toBe('done');
    expect(calls).toEqual(['stream', 'whole']);
    expect(got[0].delta).toBe('你好');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('边收边显示一连就报错（还没收到东西）：马上换方式，不原样重试', async () => {
    const calls = [];
    let streaming = true;
    const client = {
      get streaming() { return streaming; },
      streamFailed() { if (!streaming) return false; streaming = false; return true; },
      getTask: async () => ({ status: 'running', seq: 0 }),
      events: async () => { calls.push(streaming ? 'stream' : 'whole'); if (streaming) throw new TypeError('Failed to fetch'); return sse([{ seq: 1, type: 'task_state', status: 'done', text: '好' }]); }
    };
    const end = await followTask(client, 't1', { firstMs: 50, retryMs: [5000] });
    expect(end.status).toBe('done');
    expect(calls).toEqual(['stream', 'whole']);
  });

  it('能边收边显示时照常用，不退回', async () => {
    let failed = 0;
    const client = { streaming: true, streamFailed() { failed++; return true; }, getTask: async () => ({}), events: async () => sse([{ seq: 1, type: 'task_state', status: 'done', text: '好' }]) };
    await followTask(client, 't1', { firstMs: 50 });
    expect(failed).toBe(0);
  });

  it('客户端：退回后取事件流不再带 stream 标记，并记下来（一天内不再试）', async () => {
    const { createServerClient } = await import('../src/core/serverClient.js');
    const store = new Map();
    const orig = globalThis.localStorage;
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    try {
      const inits = [];
      const c = createServerClient({ base: 'https://d.example.com', token: 't', fetchImpl: async (u, init) => { inits.push(init); return new Response(''); } });
      await c.events('t1', 0);
      expect(c.streamFailed()).toBe(true);
      await c.events('t1', 0);
      expect(inits.map((i) => Boolean(i.stream))).toEqual([true, false]);
      expect(createServerClient({ base: 'https://d.example.com', fetchImpl: async () => new Response('') }).streaming).toBe(false);
    } finally {
      globalThis.localStorage = orig;
    }
  });
});
