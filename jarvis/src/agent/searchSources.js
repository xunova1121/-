import { withWebDeadline } from './retrievalBudget.js';
import { webBody } from './webBody.js';
import { retryRead, throwControl } from '../core/networkRequest.js';
import { mergeSearchHits } from './officialSources.js';

/** 同一搜索器最多4个源在途、64个等待；取消的排队请求不会在稍后偷偷发出。 */
export function sourceQueue(max = 4) {
  let active = 0;
  const waiting = [];
  const acquire = (signal) => new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(ticket);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason);
    };
    const ticket = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
    if (signal?.aborted) return reject(signal.reason);
    if (active < max) { active++; resolve(); return; }
    if (waiting.length >= 64) return reject(Object.assign(new Error('搜索排队已满'), { code: 'SEARCH_QUEUE_FULL', kind: 'api' }));
    waiting.push(ticket);
    signal?.addEventListener('abort', abort, { once: true });
  });
  return async (work, signal) => {
    await acquire(signal);
    try {
      if (signal?.aborted) throw signal.reason;
      return await work();
    } finally {
      active--;
      const next = waiting.shift();
      if (next) { active++; next.resolve(); }
    }
  };
}

/** 单词的多个免费搜索源并发2路；预算由调用方按逻辑搜索词扣，不按源或GET重试重复扣。 */
export async function collectSearchSources(plan, { get, headers, signal, describe, schedule = (work) => work() }) {
  const results = new Array(plan.length);
  let next = 0;
  let lastError;
  const worker = async () => {
    for (let index = next++; index < plan.length; index = next++) {
      if (signal?.aborted) throw signal.reason;
      const [sourceName, url, parse] = plan[index];
      try {
        const result = await schedule(() => withWebDeadline((sourceSignal) => retryRead(async (activeSignal) => {
          const response = await get(url, { headers, signal: activeSignal });
          const body = new TextDecoder().decode(await webBody(response, 2 * 1024 * 1024, activeSignal));
          if (body.length > 2 * 1024 * 1024) throw Object.assign(new Error('搜索页面过大'), { code: 'SEARCH_PAGE_LIMIT', kind: 'api' });
          const hits = response.ok ? parse(body).slice(0, 20) : [];
          return { hits, note: describe(sourceName, response.status, body, hits.length) };
        }, { signal: sourceSignal, timeoutMs: 8000 }), { signal, timeoutMs: 8000 }), signal);
        results[index] = result;
      } catch (error) {
        throwControl(error, signal);
        lastError = error;
        results[index] = { hits: [], note: `${sourceName}：连不上（${error.message}）` };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, plan.length) }, worker));
  return { hits: mergeSearchHits(results.flatMap((result) => result.hits)), notes: results.map((result) => result.note), error: lastError };
}
