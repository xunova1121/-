import { describe, it, expect } from 'vitest';
import { probeEndpoint, similarModels } from '../src/llm/probe.js';
import { safeHeaders, nativeFetcher, wrapFetch } from '../src/mobile/nativeFetch.js';

const json = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('连接诊断', () => {
  it('接口、密钥、型号都正常', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return json(200, { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-mini' }] })(); };
    const r = await probeEndpoint({ baseURL: 'https://teamorouter.com/v1/', apiKey: 'sk-1', model: 'gpt-6.1-sol', fetchImpl });
    expect(seen.url).toBe('https://teamorouter.com/v1/models');
    expect(seen.init.headers.Authorization).toBe('Bearer sk-1');
    expect(r).toMatchObject({ ok: true, step: 'done' });
    expect(r.message).toMatch('2 个可用模型');
  });
  it('型号不在列表里：给出相近的型号', async () => {
    const r = await probeEndpoint({ baseURL: 'https://x/v1', model: 'gpt6.1', fetchImpl: json(200, { data: [{ id: 'gpt-6.1-sol' }, { id: 'claude-x' }] }) });
    expect(r).toMatchObject({ ok: false, step: 'model' });
    expect(r.message).toMatch('相近的有：gpt-6.1-sol');
  });
  it('密钥错误 / 地址错误 / 网络不通 / 服务商出错 分开说', async () => {
    expect(await probeEndpoint({ baseURL: 'https://x/v1', fetchImpl: json(401, { error: { message: 'invalid api key' } }) })).toMatchObject({ step: 'key', message: expect.stringContaining('invalid api key') });
    expect((await probeEndpoint({ baseURL: 'https://x', fetchImpl: json(404, {}) })).message).toMatch('/v1');
    expect((await probeEndpoint({ baseURL: 'https://x/v1', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })).step).toBe('network');
    expect((await probeEndpoint({ baseURL: 'https://x/v1', fetchImpl: json(502, { message: 'bad gateway' }) })).message).toMatch('HTTP 502：bad gateway');
    expect((await probeEndpoint({ baseURL: 'teamorouter.com', fetchImpl: json(200, {}) })).step).toBe('url');
  });
  it('超时', async () => {
    const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const r = await probeEndpoint({ baseURL: 'https://x/v1', fetchImpl: hang, timeoutMs: 20 });
    expect(r.message).toMatch('x 0.02 秒没有响应');
    const onPhone = await probeEndpoint({ baseURL: 'https://teamorouter.com/v1', fetchImpl: hang, timeoutMs: 20, phone: true });
    expect(onPhone.message).toMatch('用手机浏览器打开 https://teamorouter.com');
  });
  it('相近型号', () => {
    expect(similarModels(['gpt-6.1-sol', 'gpt-6.1-mini', 'claude-opus'], 'gpt6.1')).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini']);
  });
});

describe('手机原生网络', () => {
  it('响应头里的状态行、非法名字被丢掉，不会让 Response 报错', async () => {
    const h = safeHeaders({ null: 'HTTP/1.1 200 OK', '': 'x', 'Content-Type': 'text/event-stream', 'bad name': 'x', 'x-ok': 'a\r\nb' });
    expect([...h.keys()]).toEqual(['content-type', 'x-ok']);
    const http = { request: async () => ({ status: 200, headers: { null: 'HTTP/1.1 200 OK', 'Content-Type': 'text/event-stream' }, data: 'data: {"x":1}\n\n' }) };
    const res = await nativeFetcher(http)('https://a.com/x', { method: 'POST', body: '{}' });
    expect(await res.text()).toBe('data: {"x":1}\n\n');
  });
  it('记录每个地址走的是哪条网络', async () => {
    const g = {};
    const f = wrapFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => new Response('ok'), 'https://localhost', g);
    expect(g.__jarvisNetVia('https://teamorouter.com/v1')).toBe('web');
    await f('https://teamorouter.com/v1/models');
    expect(g.__jarvisNetVia('https://teamorouter.com/v1')).toBe('native');
  });
});

describe('手机原生网络上传文件', () => {
  it('FormData 转成插件的 formData 格式（文件 Base64）', async () => {
    let req;
    const http = { request: async (r) => { req = r; return { status: 200, headers: {}, data: '{"text":"你好"}' }; } };
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', 'whisper-1');
    const res = await nativeFetcher(http)('https://x/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer k' }, body: form });
    expect(req.dataType).toBe('formData');
    expect(req.headers['content-type']).toBe('multipart/form-data');
    expect(req.data).toEqual([
      { key: 'file', value: 'AQID', type: 'base64File', fileName: 'speech.wav', contentType: 'audio/wav' },
      { key: 'model', value: 'whisper-1', type: 'string' }
    ]);
    expect((await res.json()).text).toBe('你好');
  });
});

import { groupSessions } from '../src/ui/drawer.js';
describe('抽屉里的历史对话分组', () => {
  it('今天 / 昨天 / 近 7 天 / 更早', () => {
    const now = new Date('2026-10-12T12:00:00').getTime();
    const g = groupSessions([
      { id: 'a', updatedAt: now - 3600e3 },
      { id: 'b', updatedAt: now - 30 * 3600e3 },
      { id: 'c', updatedAt: now - 4 * 864e5 },
      { id: 'd', updatedAt: now - 40 * 864e5 }
    ], now);
    expect(g.map(([k, v]) => [k, v.map((s) => s.id)])).toEqual([['今天', ['a']], ['昨天', ['b']], ['近 7 天', ['c']], ['更早', ['d']]]);
  });
});

import { createOpenAIAdapter, isTransient } from '../src/llm/openai.js';
describe('模型接口临时故障自动重试', () => {
  const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
  it('524 / 连接重置后重试成功', async () => {
    const replies = [new Response('timeout', { status: 524 }), 'reset', sse('好的')];
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { const r = replies.shift(); if (r === 'reset') throw new TypeError('Connection reset'); return r; };
    try {
      let text = '';
      const retries = [];
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k', retryDelays: [1, 1, 1] });
      const r = await a.stream({ model: 'm', system: ['', ''], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (d) => { text += d; }, onRetry: (n) => retries.push(n) });
      expect(r.text).toBe('好的');
      expect(text).toBe('好的');
      expect(retries).toEqual([1, 2]);
    } finally { globalThis.fetch = orig; }
  });
  it('密钥错误等不重试', async () => {
    expect(isTransient(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(isTransient(Object.assign(new Error('x'), { status: 524 }))).toBe(true);
    expect(isTransient(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('中断后接着写，不从头开始', () => {
  // 先发出一段文字，再断开连接
  const cut = (text) => {
    let n = 0;
    return new Response(new ReadableStream({
      pull(c) {
        if (n++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        else c.error(new TypeError('Connection reset'));
      }
    }), { status: 200 });
  };
  it('写了一半断开：带上已写部分让模型续写，结果拼在一起', async () => {
    const half = cut('第一段，');
    const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    const replies = [half, sse('第二段。')];
    const bodies = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return replies.shift(); };
    try {
      let shown = '';
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k', retryDelays: [1] });
      const r = await a.stream({ model: 'm', system: ['', ''], messages: [{ role: 'user', content: '写两段' }], tools: [], onText: (d) => { shown += d; } });
      expect(shown).toBe('第一段，第二段。');
      expect(r.text).toBe('第一段，第二段。');
      const msgs = bodies[1].messages;
      expect(msgs.at(-2)).toMatchObject({ role: 'assistant', content: '第一段，' });
      expect(msgs.at(-1).content).toBe(CONTINUE_PROMPT);
    } finally { globalThis.fetch = orig; }
  });
  it('重试用完仍失败：错误里带着已写的部分', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => cut('半句');
    try {
      const a = createOpenAIAdapter({ baseURL: 'https://x/v1', apiKey: 'k', retryDelays: [1] });
      const err = await a.stream({ model: 'm', system: ['', ''], messages: [{ role: 'user', content: 'x' }], tools: [] }).catch((e) => e);
      expect(err.partialText).toBe('半句半句');
    } finally { globalThis.fetch = orig; }
  });
  it('出错时：写了一部分就给“继续”，否则给“再试一次”', () => {
    expect(followUpSuggestions({ error: true, resumable: true, userText: '写报告' })[0]).toEqual({ title: '继续', prompt: CONTINUE_TEXT });
    expect(followUpSuggestions({ error: true, userText: '写报告' })[0].title).toBe('再试一次');
  });
});
import { CONTINUE_PROMPT } from '../src/llm/openai.js';
import { followUpSuggestions, CONTINUE_TEXT } from '../src/core/suggest.js';
