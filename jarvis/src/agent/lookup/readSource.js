import { withWebDeadline } from '../retrievalBudget.js';
import { webBody } from '../webBody.js';
import { decodeLookupBody } from './content.js';

/** 统一单来源读取：列表和正文共用一个8秒期限，迟到/取消不回写结果，不执行网页脚本。 */
export async function readLookupSource(source, { get = (...args) => fetch(...args), now = Date.now(), params = {}, signal, retrieval, detailLimit = 3 } = {}) {
  const started = performance.now(); let requests = 0;
  try {
    const value = await withWebDeadline(async activeSignal => {
      const read = async url => {
        if (activeSignal.aborted) throw activeSignal.reason;
        retrieval?.consume('read'); requests++;
        const response = await get(url, { signal: activeSignal, credentials: 'omit' });
        if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { code: 'LOOKUP_HTTP', status: response.status, kind: 'api' });
        const bytes = await webBody(response, 1024 * 1024, activeSignal);
        if (activeSignal.aborted) throw activeSignal.reason;
        return decodeLookupBody(bytes, response.headers.get('content-type') || '');
      };
      const body = await read(source.url);
      let parsed;
      try { parsed = source.parse(body, source, { now, params }); }
      catch (error) { throw Object.assign(new Error('解析不出：' + String(error.message).slice(0, 100)), { code: 'LOOKUP_PARSE', kind: 'parse' }); }
      const items = [...(parsed.items || [])].slice(0, 36), failures = [];
      if (source.parseArticle) {
        const extra = await Promise.all((parsed.candidates || []).slice(0, Math.min(5, Math.max(0, detailLimit))).map(async candidate => {
          try { return source.parseArticle(await read(candidate.url), source, candidate, { now, params }); }
          catch (error) {
            if (activeSignal.aborted || error.code === 'RETRIEVAL_BUDGET' || error.name === 'AbortError') throw error;
            failures.push(String(error.message).slice(0, 100)); return [];
          }
        }));
        items.push(...extra.flat());
      }
      if (activeSignal.aborted) throw activeSignal.reason;
      return { items: items.slice(0, 36).map(row => ({ ...row, kind: source.kind, sourceId: source.id, verified: row.verified || 'index', source: row.source || source.label })), failures };
    }, { signal, timeoutMs: Math.min(8000, source.timeoutMs || 8000) });
    return { source: source.id, label: source.label, url: source.url, state: value.items.length ? 'ok' : 'empty', items: value.items,
      reason: value.items.length ? '' : value.failures.length ? value.failures.slice(0, 2).join('；') : '当前时间范围无可验证内容，或列表没有明确发布时间', elapsedMs: Math.round(performance.now() - started), requests };
  } catch (error) {
    if (signal?.aborted || error.code === 'RETRIEVAL_BUDGET' || error.name === 'AbortError') throw error;
    return { source: source.id, label: source.label, url: source.url, state: 'failed', items: [], reason: error.name === 'TimeoutError' ? '超时（来源总期限8秒）' : error.code === 'LOOKUP_PARSE' ? error.message : error.status ? '来源返回HTTP ' + error.status : '连不上：' + String(error.message).slice(0, 100), code: error.code || (error.name === 'TimeoutError' ? 'LOOKUP_TIMEOUT' : 'LOOKUP_NETWORK'), elapsedMs: Math.round(performance.now() - started), requests };
  }
}
