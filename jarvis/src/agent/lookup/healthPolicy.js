/** 本地控制/输入拦截没有发出请求，不能证明上游断网。也用于修正旧版本保存的误判。 */
const LOCAL_CODES = new Set([
  'REPEATED_SEARCH', 'RETRIEVAL_BUDGET', 'ABORT_ERR', 'LOOKUP_SOURCE_COOLING',
  'UNTRUSTED_JSON_HOST', 'INVALID_STOCK_INPUT', 'INVALID_QUOTE_INPUT',
  'SEARCH_NOT_REQUESTED', 'ValidationError', 'AbortError'
]);

export const localLookupFailure = error => LOCAL_CODES.has(error?.code) || ['AbortError', 'ValidationError'].includes(error?.name);

export function consecutiveLookupFailures(samples) {
  const network = samples.filter(sample => !localLookupFailure(sample));
  const last = network.slice(-3);
  return last.length === 3 && last.every(sample => !sample.connected);
}
