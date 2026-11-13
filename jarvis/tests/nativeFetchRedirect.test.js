import { describe, it, expect, vi } from 'vitest';
import { nativeFetcher } from '../src/mobile/nativeFetch.js';
import { createOpenaiSearchFetch } from '../src/core/openaiSearchGateway.js';

describe('原生独立搜索不转发凭据到重定向地址', () => {
  it('系统网络收到disableRedirects，成功请求保留POST与独立Key', async () => {
    const http = { request: vi.fn(async () => ({ status: 200, data: '{"output":[]}', headers: {} })) };
    const get = createOpenaiSearchFetch({}, { nativeFetch: nativeFetcher(http) });
    const response = await get('https://search.example/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer search-key' }, body: '{}', redirect: 'error' });
    expect(response.status).toBe(200);
    expect(http.request.mock.calls[0][0]).toMatchObject({
      url: 'https://search.example/v1/responses', method: 'POST', data: '{}',
      headers: { authorization: 'Bearer search-key' }, disableRedirects: true, readTimeout: 20000
    });
  });
  it.each([301, 302, 303, 307, 308])('禁止模式收到%s即报固定错误，不返回上游文本', async status => {
    const http = { request: vi.fn(async () => ({ status, data: 'secret-key', headers: { Location: 'https://other.example/secret-key' } })) };
    await expect(nativeFetcher(http)('https://search.example/v1/responses', { redirect: 'error' })).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED', message: '此请求不允许重定向' });
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request.mock.calls[0][0].disableRedirects).toBe(true);
  });
  it('旧普通请求的默认跳转行为不变', async () => {
    const http = { request: vi.fn(async () => ({ status: 200, data: 'normal page', headers: {} })) };
    expect(await (await nativeFetcher(http)('https://page.example/')).text()).toBe('normal page');
    expect(http.request.mock.calls[0][0]).not.toHaveProperty('disableRedirects');
  });
});
