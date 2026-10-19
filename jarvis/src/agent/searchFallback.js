import { parseBaidu, parseSo360, DESKTOP_HEADERS } from './webSearch.js';
import { retryRead, httpError, throwControl } from '../core/networkRequest.js';

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
      const hits = await retryRead(
        async (requestSignal) => {
          const response = await get(provider.url, { signal: requestSignal, headers: DESKTOP_HEADERS });
          if (!response.ok) throw httpError(response.status, '', provider.source);
          return provider.parse(await response.text()).slice(0, 5);
        },
        { signal, timeoutMs: 4000, beforeAttempt: () => retrieval?.consume('search') }
      );
      if (hits.length) return { source: provider.source, searchUrl: provider.url, kind: 'search_snippets', hits };
      failures.push(provider.source + '未取得可解析结果');
    } catch (error) {
      throwControl(error, signal);
      failures.push(provider.source + '：' + error.message);
    }
  }
  throw Object.assign(new Error('已尝试360和百度，仍未取得聚合线索：' + failures.join('；')), { code: 'SEARCH_FALLBACK_FAILED', kind: 'network' });
}
