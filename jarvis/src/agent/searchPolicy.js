/** 搜索聚合入口不熔断：各引擎各自退避，同轮失败的引擎不因换词再次请求。 */
import { localLookupFailure } from './lookup/healthPolicy.js';
export const SEARCH_WINDOW_MS = 20_000;
const turnFailures = new WeakMap();

export function searchRetryAfter(response, now = Date.now()) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function searchBackoff(error) {
  if (localLookupFailure(error)) return 0;
  if ([401, 402, 403, 429].includes(error.status)) return Math.max(180_000, error.retryAfterMs || 0);
  if (error.status >= 500 || ['network', 'timeout'].includes(error.kind) || ['TypeError', 'TimeoutError', 'NetworkError'].includes(error.name)) return 30_000;
  return 0;
}

export function guardedSearchRoute(engine, id, now = Date.now) {
  if (!engine) return null;
  let until = 0;
  let failures = 0;
  return {
    ...engine,
    async search(query, count, options = {}) {
      if (options.signal?.aborted) throw options.signal.reason;
      const context = options.routeContext;
      let failed;
      if (context && typeof context === 'object') {
        if (!turnFailures.has(context)) turnFailures.set(context, new Set());
        failed = turnFailures.get(context);
      }
      if (until > now() || failed?.has(id)) {
        throw Object.assign(new Error(`${engine.name}本轮暂停，继续其他搜索来源`), { code: 'SEARCH_ROUTE_PAUSED', skipped: true });
      }
      try {
        const result = await engine.search(query, count, options);
        failures = 0;
        return result;
      } catch (error) {
        // 用户停止、总预算到期和换源取消不属于服务商故障。
        if (options.signal?.aborted || error.name === 'AbortError' || ['RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED'].includes(error.code)) throw error;
        const delay = searchBackoff(error);
        if (delay || error.skipped) failed?.add(id);
        // 普通服务故障须连续确认，避免某一个查询503就挡住下一批其他查询。
        if (delay && (++failures >= 3 || [401, 402, 403, 429].includes(error.status))) until = now() + delay;
        throw error;
      }
    }
  };
}

/** 进度只展示固定状态，禁止将上游错误正文、URL参数或Key带进对话。 */
export function searchFailureLabel(error) {
  if (error.skipped) return '本轮暂停，已转其他来源';
  if (Number.isInteger(error.status)) return `HTTP ${error.status}`;
  if (error.name === 'TimeoutError' || error.kind === 'timeout') return '请求超时';
  if (['network'].includes(error.kind) || ['NetworkError', 'TypeError'].includes(error.name)) return '连接失败';
  return '未取得有效结果';
}
