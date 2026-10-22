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
    expect(run(['你好', '，我是未央'])).toEqual({ text: '你好，我是未央', hint: null });
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
    const srv = await import('../server/server.mjs');
    srv.EXTRA_UPSTREAMS.elevenlabs = `http://127.0.0.1:${upstream.address().port}`;
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

  it('ElevenLabs 语音：转发 xi-api-key，未填时用网关密钥', async () => {
    process.env.ELEVENLABS_API_KEY = 'el-env';
    await (await fetch(`${base}/api/llm/elevenlabs/v1/text-to-speech/abc?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': 'use-gateway-key' }, body: '{}' })).text();
    expect(seen.url).toBe('/v1/text-to-speech/abc?output_format=mp3_44100_128');
    expect(seen.headers['xi-api-key']).toBe('el-env');
    await (await fetch(`${base}/api/llm/elevenlabs/v1/text-to-speech/abc`, { method: 'POST', headers: { 'xi-api-key': 'el-user' }, body: '{}' })).text();
    expect(seen.headers['xi-api-key']).toBe('el-user');
    delete process.env.ELEVENLABS_API_KEY;
  });

  it('自定义接口：按请求头里的地址转发（绕开浏览器跨域）', async () => {
    const up = `http://127.0.0.1:${upstream.address().port}/v1`;
    const r = await fetch(`${base}/api/llm/custom/chat/completions`, { method: 'POST', headers: { 'x-jarvis-upstream': up, Authorization: 'Bearer sk-custom' }, body: '{"model":"x"}' });
    expect(await r.text()).toBe('data: {"ok":true}\n\n');
    expect(seen.url).toBe('/v1/chat/completions');
    expect(seen.headers.authorization).toBe('Bearer sk-custom');
    expect(seen.headers['x-jarvis-upstream']).toBeUndefined();
  });

  it('单文件版（Origin: null）可跨域使用：只开放模型转发，不注入网关密钥，不转发到内网', async () => {
    const pre = await fetch(`${base}/api/llm/deepseek/chat/completions`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, x-stainless-os' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('null');
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization, content-type, x-stainless-os');
    expect(pre.headers.get('access-control-allow-private-network')).toBeNull();

    const h = await fetch(`${base}/api/health`, { headers: { Origin: 'null' } });
    expect(h.headers.get('access-control-allow-origin')).toBe('null');
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    expect(await h.json()).toMatchObject({ ok: true, cors: true, gatewayKeys: [] });

    await (await fetch(`${base}/api/llm/deepseek/chat/completions`, { method: 'POST', headers: { Origin: 'null' }, body: '{}' })).text();
    expect(seen.headers.authorization).toBeUndefined(); // 环境变量里的密钥不会借给跨域请求
    await (await fetch(`${base}/api/llm/deepseek/chat/completions`, { method: 'POST', headers: { Origin: 'null', Authorization: 'Bearer sk-user' }, body: '{}' })).text();
    expect(seen.headers.authorization).toBe('Bearer sk-user');
    delete process.env.DEEPSEEK_API_KEY;

    const up = `http://127.0.0.1:${upstream.address().port}/v1`;
    expect((await fetch(`${base}/api/llm/custom/chat/completions`, { method: 'POST', headers: { Origin: 'null', 'x-jarvis-upstream': up }, body: '{}' })).status).toBe(400);
    const f = await fetch(`${base}/api/fetch?url=${encodeURIComponent('https://example.com/')}`, { headers: { Origin: 'null' } });
    expect(f.headers.get('access-control-allow-origin')).toBeNull();
    const other = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('未知服务商、无效的自定义地址不代理', async () => {
    expect((await fetch(`${base}/api/llm/evil/x`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/llm/custom/x`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${base}/api/llm/custom/x`, { method: 'POST', headers: { 'x-jarvis-upstream': 'file:///etc/passwd' } })).status).toBe(400);
  });

  it('网页读取拒绝内网地址', async () => {
    for (const u of ['http://127.0.0.1:1/', 'http://localhost/', 'http://192.168.1.1/', 'file:///etc/passwd', 'http://[::1]/']) {
      expect((await fetch(`${base}/api/fetch?url=${encodeURIComponent(u)}`)).status).toBe(403);
    }
  });
});

describe('阿里云 OSS 同步已去掉', () => {
  let server, base;
  beforeAll(async () => {
    server = createServer({ agent: new MockAgent({ charDelayMs: 0 }), staticDir: '/nonexistent' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());
  it('网关不再转发 /api/oss', async () => {
    const r = await fetch(`${base}/api/oss`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-client': '1' }, body: JSON.stringify({ method: 'GET', url: 'https://my-jarvis.oss-cn-hangzhou.aliyuncs.com/x', headers: {} }) });
    expect(r.headers.get('x-oss-status')).toBeNull();
  });
});
