import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { proxyDeepseekTool } from '../server/deepseekProxy.mjs';

function incoming(headers = {}, body = '{}') {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.headers = headers;
  return req;
}
function outgoing() {
  return Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() });
}
describe('DeepSeek固定网关代理', () => {
  it('服务器登录凭据不作为上游密钥，缺少独立上游头时拒绝', async () => {
    const json = vi.fn(),
      fetchImpl = vi.fn();
    await proxyDeepseekTool(incoming({ authorization: 'Bearer server-login-token' }), outgoing(), 'search', { serverMode: true, json, fetchImpl });
    expect(json.mock.calls[0][1]).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('仅转发官方Key与JSON，不把登录令牌或自定义目标传给上游', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/v1/tools/search');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer upstream-key' });
      expect(init.redirect).toBe('error');
      return new Response('{"results":[]}');
    });
    const res = outgoing();
    await proxyDeepseekTool(incoming({ authorization: 'Bearer server-login-token', 'x-jarvis-search-key': 'upstream-key' }), res, 'search', {
      serverMode: true,
      json: vi.fn(),
      fetchImpl
    });
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(String(res.end.mock.calls[0][0])).toBe('{"results":[]}');
    expect(res.listenerCount('close')).toBe(0);
  });
  it('本机网关使用Bearer官方Key，过大的请求不发送', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer local-key');
      return new Response('{"title":"示例","content":"正文"}');
    });
    await proxyDeepseekTool(incoming({ authorization: 'Bearer local-key' }), outgoing(), 'fetch', { json: vi.fn(), fetchImpl });
    const json = vi.fn();
    await proxyDeepseekTool(incoming({ authorization: 'Bearer local-key' }, 'x'.repeat(32769)), outgoing(), 'fetch', { json, fetchImpl });
    expect(json.mock.calls[0][1]).toBe(413);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
