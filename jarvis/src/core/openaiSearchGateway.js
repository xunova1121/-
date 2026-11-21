/** 自定义搜索单独代理 POST，避免通用读网页网关丢失请求体和独立搜索 Key。 */
import { loadServerSettings, normalizeUrl } from './serverClient.js';
import { nativeWebFetch } from '../mobile/nativeFetch.js';
import { openaiSearchEndpoint } from '../agent/openaiSearch.js';

export function createOpenaiSearchFetch(app, {
  storage = globalThis.localStorage,
  fetchImpl = (...args) => fetch(...args),
  nativeFetch = globalThis.__jarvisNativeFetch
} = {}) {
  if (!app.gateway) return nativeFetch ? (url, init = {}) => nativeWebFetch(nativeFetch)(url, { ...init, readTimeout: 20000 }) : null;
  return (url, init = {}) => {
    const protocol = new URL(url).pathname.replace(/\/+$/, '').endsWith('/chat/completions') ? 'chat-completions' : 'responses';
    const target = openaiSearchEndpoint(url, protocol);
    const upstreamKey = String(new Headers(init.headers).get('authorization') || '').replace(/^Bearer\s+/i, '');
    const headers = new Headers({
      'Content-Type': 'application/json',
      'x-jarvis-client': '1',
      'x-jarvis-upstream': target,
      'x-jarvis-search-key': upstreamKey
    });
    const origin = normalizeUrl(app.gateway.origin);
    if (app.gateway.serverMode) {
      const saved = loadServerSettings(storage);
      if (!saved.token || normalizeUrl(saved.url) !== origin)
        throw Object.assign(new Error('请先登录当前未央服务器，再测试搜索'), { code: 'SEARCH_GATEWAY_LOGIN', kind: 'api' });
      headers.set('Authorization', 'Bearer ' + saved.token);
    }
    return fetchImpl(`${origin}/api/llm/openai-search/${protocol}`, {
      method: 'POST', headers, body: init.body, signal: init.signal,
      credentials: 'omit', redirect: 'error'
    });
  };
}
