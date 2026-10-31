import { failureKind } from './recoveryData.js';
import { withWebDeadline } from '../retrievalBudget.js';
import { webBody } from '../webBody.js';
import { decodeLookupBody } from './content.js';

/** 统一单来源读取：列表和正文共用一个5秒期限，迟到/取消不回写结果，不执行网页脚本。 */
export async function readLookupSource(source, { get = (...args) => fetch(...args), now = Date.now(), params = {}, signal, retrieval, detailLimit = 3, requestLimit = Infinity } = {}) {
  const started = performance.now(); let requests = 0;
  try {
    const value = await withWebDeadline(async activeSignal => {
      const read = async url => {
        if (activeSignal.aborted) throw activeSignal.reason;
        if (requests >= requestLimit) throw Object.assign(new Error('已为其他来源保留读取额度'), { code: 'LOOKUP_READ_RESERVED' });
        retrieval?.consume('read'); requests++;
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await withWebDeadline(s => get(url, { signal: s, credentials: 'omit' }), { signal: activeSignal, timeoutMs: attempt ? 1500 : 3000 });
            if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { code: 'LOOKUP_HTTP', status: response.status, kind: 'api' });
            break;
          } catch (error) {
            if (activeSignal.aborted || attempt || requests >= requestLimit || failureKind(error) !== 'transient') throw error;
            retrieval?.consume('read'); requests++;
          }
        }
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
    }, { signal, timeoutMs: Math.min(5000, source.timeoutMs || 5000) });
    return { source: source.id, label: source.label, url: source.url, state: value.items.length ? 'ok' : 'empty', items: value.items,
      warnings: value.failures.slice(0, 5),
      reason: value.items.length ? '' : value.failures.length ? value.failures.slice(0, 2).join('；') : '当前时间范围无可验证内容，或列表没有明确发布时间', elapsedMs: Math.round(performance.now() - started), requests };
  } catch (error) {
    if (signal?.aborted || error.code === 'RETRIEVAL_BUDGET' || error.name === 'AbortError') throw error;
    return { source: source.id, label: source.label, url: source.url, state: 'failed', items: [], reason: error.name === 'TimeoutError' ? '超时（来源总期限5秒）' : error.code === 'LOOKUP_PARSE' ? error.message : error.status ? '来源返回HTTP ' + error.status : '连不上：' + String(error.message).slice(0, 100), status: error.status, code: error.code || (error.name === 'TimeoutError' ? 'LOOKUP_TIMEOUT' : 'LOOKUP_NETWORK'), elapsedMs: Math.round(performance.now() - started), requests };
  }
}
