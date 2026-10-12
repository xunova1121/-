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
    expect(r.message).toMatch('没有响应');
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
