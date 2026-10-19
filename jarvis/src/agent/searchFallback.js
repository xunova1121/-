import { parseBaidu, parseSo360, DESKTOP_HEADERS } from './webSearch.js';
import { retryRead, httpError, throwControl } from '../core/networkRequest.js';

export function safeFallbackQuery(url, requestText = '') {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  if (target.username || target.password || /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[::1\])/.test(host) || /\.(?:local|internal)$/.test(host)) {
    throw Object.assign(new Error('私有或含凭据的地址不发送到公共搜索引擎'), { code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403 });
  }
  const text = String(requestText).replace(/https?:\/\/[^\s]+/gi, '').trim();
  // 明显含凭据的任务只搜索公共主机名，不向聚合引擎发送原任务或URL参数。
  return /密码|密钥|token|password|api.?key|authorization/i.test(text) ? host : (text.slice(0, 160) || host);
}

/** 聚合结果仅是线索，不能缓存到原站正文名下。 */
export async function searchAggregateHints(query, { get, signal, retrieval } = {}) {
  const q = encodeURIComponent(String(query).slice(0, 300));
  const providers = [
    { source: '360', url: 'https://www.so.com/s?q=' + q, parse: parseSo360 },
    { source: '百度', url: 'https://www.baidu.com/s?wd=' + q, parse: parseBaidu }
  ];
  const failures = [];
  for (const provider of providers) {
    try {
      const hits = await retryRead(async requestSignal => {
        const response = await get(provider.url, { signal: requestSignal, headers: DESKTOP_HEADERS });
        if (!response.ok) throw httpError(response.status, '', provider.source);
        return provider.parse(await response.text()).slice(0, 5);
      }, { signal, timeoutMs: 4000, beforeAttempt: () => retrieval?.consume('search') });
      if (hits.length) return { source: provider.source, searchUrl: provider.url, kind: 'search_snippets', hits };
      failures.push(provider.source + '未取得可解析结果');
    } catch (error) {
      throwControl(error, signal);
      failures.push(provider.source + '：' + error.message);
    }
  }
  throw Object.assign(new Error('已尝试360和百度，仍未取得聚合线索：' + failures.join('；')), { code: 'SEARCH_FALLBACK_FAILED', kind: 'network' });
}
