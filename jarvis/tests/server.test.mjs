import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EmotionTagStripper } from '../shared/emotionTag.js';
import { sanitizeHistory, MockAgent } from '../server/agents.mjs';
import { createServer } from '../server/server.mjs';
import { parseFrame } from '../src/api/chat.js';

describe('EmotionTagStripper', () => {
  const run = (chunks) => {
    const s = new EmotionTagStripper();
    let text = '';
    let hint = null;
    for (const c of chunks) {
      const r = s.push(c);
      text += r.text;
      hint ??= r.hint;
    }
    const r = s.flush();
    return { text: text + r.text, hint: hint ?? r.hint };
  };

  it('跨 token 拆开的标签也能剥离', () => {
    expect(run(['<emo', 'tion>安', '抚</emo', 'tion>', '没关系，', '慢慢来。'])).toEqual({ text: '没关系，慢慢来。', hint: '安抚' });
  });

  it('没有标签时原样透传', () => {
    expect(run(['你好', '，我是贾维斯'])).toEqual({ text: '你好，我是贾维斯', hint: null });
  });

  it('未知情绪丢弃 hint 但仍剥离标签', () => {
    expect(run(['<emotion>狂喜</emotion>好的'])).toEqual({ text: '好的', hint: null });
  });

  it('前导空白与标签后的换行被吃掉', () => {
    expect(run(['\n <emotion>警觉</emotion>\n注意'])).toEqual({ text: '注意', hint: '警觉' });
  });

  it('像标签但一直不闭合时超过 48 字放行', () => {
    const long = '<emotion' + '很'.repeat(60);
    expect(run([long]).text).toBe(long);
  });

  it('流在标签中途结束时把缓冲吐出', () => {
    expect(run(['<emot'])).toEqual({ text: '<emot', hint: null });
  });
});

describe('sanitizeHistory', () => {
  it('过滤非法角色、合并相邻同角色、以 user 开头', () => {
    expect(sanitizeHistory([
      { role: 'assistant', content: '前置' },
      { role: 'system', content: 'x' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: 'c' }
    ])).toEqual([{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c' }]);
    expect(sanitizeHistory(null)).toEqual([]);
  });
});

describe('parseFrame', () => {
  it('解析 data 行并补齐字段', () => {
    expect(parseFrame('data: {"delta":"你"}')).toEqual({ delta: '你', emotion_hint: null, task_state: null, tool: null });
    expect(parseFrame(': ping')).toBeNull();
    expect(parseFrame('data: [DONE]')).toBeNull();
    expect(parseFrame('data: {oops')).toBeNull();
  });
});

describe('网关', () => {
  let server;
  let base;
  beforeAll(async () => {
    server = createServer({ agent: new MockAgent({ charDelayMs: 0 }), internalToken: 'secret-token', staticDir: '/nonexistent' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  async function chat(text) {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const raw = await res.text();
    return raw.split('\n\n').map(parseFrame).filter(Boolean);
  }

  it('对话流：processing → hint → listening 文本 → done', async () => {
    const evs = await chat('最近压力好大');
    expect(evs[0].task_state).toBe('processing');
    expect(evs.find((e) => e.emotion_hint)?.emotion_hint).toBe('安抚');
    expect(evs.at(-1).task_state).toBe('done');
    const text = evs.map((e) => e.delta).join('');
    expect(text).toContain('没关系');
  });

  it('工具调用期间上报 processing 与工具名', async () => {
    const evs = await chat('电脑现在状态怎么样');
    expect(evs.some((e) => e.task_state === 'processing' && e.tool === 'get_local_metrics')).toBe(true);
    expect(evs.map((e) => e.delta).join('')).toMatch(/CPU/);
  });

  it('本机指标', async () => {
    const m = await (await fetch(`${base}/api/local/metrics`)).json();
    expect(m.memory.percent).toBeGreaterThan(0);
    expect(m.network).toHaveProperty('online');
    expect(m.tasks.active).toBe(0);
  });

  it('情绪注入：鉴权、校验、广播到事件流', async () => {
    const denied = await fetch(`${base}/api/agent/emotion`, { method: 'POST', body: JSON.stringify({ state: '警觉' }) });
    expect(denied.status).toBe(403);

    const bad = await fetch(`${base}/api/agent/emotion`, {
      method: 'POST', headers: { Authorization: 'Bearer secret-token' }, body: JSON.stringify({ state: '狂喜' })
    });
    expect(bad.status).toBe(400);

    const ctrl = new AbortController();
    const es = await fetch(`${base}/api/agent/events`, { signal: ctrl.signal });
    const reader = es.body.getReader();
    await reader.read(); // ": connected"

    const ok = await fetch(`${base}/api/agent/emotion`, {
      method: 'POST', headers: { Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ state: '警觉', ttl_ms: 5000, source: 'workflow_watcher' })
    });
    expect(ok.status).toBe(202);
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain('event: emotion');
    expect(frame).toContain('"state":"警觉"');
    expect(frame).toContain('"ttl_ms":5000');
    ctrl.abort();
  });

  it('未知接口 404，健康检查报告后端模式', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ backend: 'mock' });
  });
});

describe('大模型代理与网页读取', () => {
  let server, base, upstream, seen;
  beforeAll(async () => {
    const { createServer: cs } = await import('../server/server.mjs');
    const http = await import('node:http');
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { seen = { url: req.url, headers: req.headers, body }; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"ok":true}\n\n'); });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const providers = await import('../shared/providers.js');
    providers.providerById('deepseek').baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
    server = cs({ agent: new MockAgent({ charDelayMs: 0 }), staticDir: '/nonexistent' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => { server.close(); upstream.close(); });

  it('转发到服务商、保留路径与流式响应，注入网关密钥', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    const r = await fetch(`${base}/api/llm/deepseek/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"m"}' });
    expect(await r.text()).toBe('data: {"ok":true}\n\n');
    expect(seen.url).toBe('/v1/chat/completions');
    expect(seen.headers.authorization).toBe('Bearer sk-env');
    expect(seen.body).toBe('{"model":"m"}');
    const r2 = await fetch(`${base}/api/llm/deepseek/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer sk-user' }, body: '{}' });
    await r2.text();
    expect(seen.headers.authorization).toBe('Bearer sk-user');
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('未知服务商与自定义地址不代理', async () => {
    expect((await fetch(`${base}/api/llm/evil/x`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/llm/custom/x`, { method: 'POST' })).status).toBe(404);
  });

  it('网页读取拒绝内网地址', async () => {
    for (const u of ['http://127.0.0.1:1/', 'http://localhost/', 'http://192.168.1.1/', 'file:///etc/passwd', 'http://[::1]/']) {
      expect((await fetch(`${base}/api/fetch?url=${encodeURIComponent(u)}`)).status).toBe(403);
    }
  });
});
