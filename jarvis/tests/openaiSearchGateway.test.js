import { describe, it, expect, vi } from 'vitest';
import { createOpenaiSearchFetch } from '../src/core/openaiSearchGateway.js';
import { saveServerSettings } from '../src/core/serverClient.js';

const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
};
const endpoint = 'https://search.example/v1/responses';
const init = { method: 'POST', headers: { Authorization: 'Bearer independent-search-key', Cookie: 'must-not-leave' }, body: '{"model":"search-model"}' };

describe('独立搜索本机网关', () => {
  it('保留POST和正文，独立Key单独传送，不经过GET网页抓取', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const ctrl = new AbortController();
    const get = createOpenaiSearchFetch({ gateway: { origin: 'http://127.0.0.1:8787' } }, { fetchImpl });
    await get(endpoint, { ...init, signal: ctrl.signal });
    const [url, sent] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8787/api/llm/openai-search/responses');
    expect(sent).toMatchObject({ method: 'POST', body: init.body, signal: ctrl.signal, redirect: 'error', credentials: 'omit' });
    expect(sent.headers.get('x-jarvis-upstream')).toBe(endpoint);
    expect(sent.headers.get('x-jarvis-search-key')).toBe('independent-search-key');
    expect(sent.headers.get('authorization')).toBeNull();
    expect(sent.headers.get('cookie')).toBeNull();
  });
  it('服务器登录令牌仅用于网关认证，且按当前账号存储读取', async () => {
    const storage = memory();
    saveServerSettings({ url: 'https://weiyang.example/', token: 'login-only', enabled: true }, storage);
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const get = createOpenaiSearchFetch({ gateway: { origin: 'https://weiyang.example', serverMode: true } }, { storage, fetchImpl });
    await get('https://search.example/v1/chat/completions', init);
    const [url, sent] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://weiyang.example/api/llm/openai-search/chat-completions');
    expect(sent.headers.get('authorization')).toBe('Bearer login-only');
    expect(sent.headers.get('x-jarvis-search-key')).toBe('independent-search-key');
    expect(sent.headers.get('x-jarvis-upstream')).not.toContain('login-only');
  });
  it('不同服务器的登录凭据不发送', () => {
    const storage = memory();
    saveServerSettings({ url: 'https://other.example', token: 'wrong-server', enabled: true }, storage);
    const fetchImpl = vi.fn();
    const get = createOpenaiSearchFetch({ gateway: { origin: 'https://weiyang.example', serverMode: true } }, { storage, fetchImpl });
    expect(() => get(endpoint, init)).toThrow('请先登录');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('无网关的原生手机保留独立POST，无原生网络返回null', async () => {
    const nativeFetch = vi.fn(async () => new Response('{}'));
    await createOpenaiSearchFetch({}, { nativeFetch })(endpoint, init);
    expect(nativeFetch.mock.calls[0][0]).toBe(endpoint);
    expect(nativeFetch.mock.calls[0][1]).toMatchObject(init);
    expect(createOpenaiSearchFetch({}, { nativeFetch: null })).toBeNull();
  });
  it('拒绝私网及URL凭据，跨域单文件网关仍用独立代理', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const get = createOpenaiSearchFetch({ gateway: { origin: 'http://127.0.0.1:8787', cors: true } }, { fetchImpl });
    expect(() => get('https://127.0.0.1/v1/responses', init)).toThrow('公网');
    expect(() => get('https://name:password@search.example/v1/responses', init)).toThrow('公网');
    await get(endpoint, init);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
