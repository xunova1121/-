import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { proxyOpenaiSearch } from '../server/openaiSearchProxy.mjs';
import { publicFetch } from '../server/taskRunner.mjs';

const headers = { authorization: 'Bearer weiyang-login-only', 'x-jarvis-search-key': 'independent-search-key', 'x-jarvis-upstream': 'https://search.example/v1/responses' };
const incoming = (extra = {}, body = '{"model":"search-model","stream":false}') => Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', headers: { ...headers, ...extra } });
const outgoing = () => Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() });

describe('自定义搜索受控代理', () => {
  it('只转发独立Key与JSON，登录和Cookie不会出站', async () => {
    const fetchImpl = vi.fn(async (_url, sent) => {
      expect(sent.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer independent-search-key' });
      expect(sent.redirect).toBe('error');
      expect(JSON.parse(sent.body).model).toBe('search-model');
      return new Response('{"output":[]}');
    });
    const res = outgoing();
    await proxyOpenaiSearch(incoming({ cookie: 'secret-cookie' }), res, 'responses', { json: vi.fn(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(headers['x-jarvis-upstream'], expect.any(Object));
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(String(res.end.mock.calls[0][0])).toBe('{"output":[]}');
    expect(res.listenerCount('close')).toBe(0);
  });
  it('缺独立Key时不能拿登录Token或环境Key顶替', async () => {
    const json = vi.fn(), fetchImpl = vi.fn();
    await proxyOpenaiSearch(incoming({ 'x-jarvis-search-key': '' }), outgoing(), 'responses', { json, fetchImpl });
    expect(json.mock.calls[0][1]).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['http://search.example/v1/responses', 'https://127.0.0.1/v1/responses', 'https://user:secret@search.example/v1/responses', 'https://search.example/v1/responses?key=secret', 'https://search.example/v1/responses#secret', 'https://search.example/v1/chat/completions'])('拒绝无效目标 %s', async target => {
    const json = vi.fn(), fetchImpl = vi.fn();
    await proxyOpenaiSearch(incoming({ 'x-jarvis-upstream': target }), outgoing(), 'responses', { json, fetchImpl });
    expect(json.mock.calls[0][1]).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret');
  });
  it('沿publicFetch拒绝解析到私网的域名', async () => {
    const upstream = vi.fn(), json = vi.fn();
    const fetchImpl = (url, init) => publicFetch(url, init, upstream, async () => [{ address: '127.0.0.1', family: 4 }]);
    await proxyOpenaiSearch(incoming(), outgoing(), 'responses', { json, fetchImpl });
    expect(json.mock.calls[0][1]).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('上游重定向不跟随，错误不回显跳转地址或凭据', async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/secret' } }));
    const json = vi.fn();
    const fetchImpl = (url, init) => publicFetch(url, init, upstream, async () => [{ address: '1.1.1.1', family: 4 }]);
    await proxyOpenaiSearch(incoming(), outgoing(), 'responses', { json, fetchImpl });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][2].code).toBe('REDIRECT_BLOCKED');
    expect(JSON.stringify(json.mock.calls)).not.toMatch(/evil|secret|independent-search-key/);
  });
  it.each(['x'.repeat(32769), '{bad json', '{"stream":true}', '[]'])('非法或超限请求不出站', async body => {
    const json = vi.fn(), fetchImpl = vi.fn();
    await proxyOpenaiSearch(incoming({}, body), outgoing(), 'responses', { json, fetchImpl });
    expect([400, 413]).toContain(json.mock.calls[0][1]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('上游错误正文不读取、不回显Key', async () => {
    const json = vi.fn();
    await proxyOpenaiSearch(incoming(), outgoing(), 'responses', { json, fetchImpl: async () => new Response('independent-search-key https://secret.example', { status: 401 }) });
    expect(json.mock.calls[0][1]).toBe(401);
    expect(json.mock.calls[0][2].upstreamStatus).toBe(401);
    expect(JSON.stringify(json.mock.calls)).not.toMatch(/independent-search-key|secret\.example/);
  });
  it('响应大小有限，取消读取超限正文', async () => {
    const json = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2097153)); }, cancel });
    await proxyOpenaiSearch(incoming(), outgoing(), 'responses', { json, fetchImpl: async () => new Response(stream) });
    expect(json.mock.calls[0][1]).toBe(413);
    expect(cancel).toHaveBeenCalled();
  });
  it('传输忽略signal也按时停止等待，迟到响应不交付', async () => {
    const json = vi.fn();
    await proxyOpenaiSearch(incoming(), outgoing(), 'responses', { json, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
    expect(json.mock.calls[0][1]).toBe(504);
    expect(json.mock.calls[0][2].code).toBe('OPENAI_SEARCH_TIMEOUT');
  });
  it('客户端断开会中止上游且清理监听', async () => {
    const res = outgoing(), json = vi.fn();
    let signal;
    const fetchImpl = async (_url, init) => {
      signal = init.signal;
      res.destroyed = true;
      res.emit('close');
      return new Promise(() => {});
    };
    await proxyOpenaiSearch(incoming(), res, 'responses', { json, fetchImpl });
    expect(signal.aborted).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
});
