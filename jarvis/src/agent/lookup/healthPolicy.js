/** 本地控制/输入拦截没有发出请求，不能证明上游断网。也用于修正旧版本保存的误判。 */
const LOCAL_CODES = new Set([
  'REPEATED_SEARCH', 'RETRIEVAL_BUDGET', 'ABORT_ERR', 'LOOKUP_SOURCE_COOLING',
  'UNTRUSTED_JSON_HOST', 'INVALID_STOCK_INPUT', 'INVALID_QUOTE_INPUT',
  'PRIVATE_NETWORK_BLOCKED', 'REDIRECT_BLOCKED', 'EVAL_QUOTA', 'EVAL_EXPIRED',
  'SEARCH_NOT_REQUESTED', 'ValidationError', 'AbortError'
]);

export const localLookupFailure = error => LOCAL_CODES.has(error?.code) || ['AbortError', 'ValidationError'].includes(error?.name);

/** 只能由明确的连接/服务端错误触发退避；空内容、解析及普通4xx不代表断网。 */
export function providerLookupFailure(value = {}) {
  if (localLookupFailure(value)) return false;
  if (Number.isInteger(value.status)) return value.status >= 500 || [401, 403, 429].includes(value.status);
  if (['network', 'timeout'].includes(value.kind) || ['TypeError', 'TimeoutError', 'NetworkError'].includes(value.name)) return true;
  return /^(?:LOOKUP_AUTH|LOOKUP_TIMEOUT|LOOKUP_NETWORK|TimeoutError|TypeError|NetworkError|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(value.code || '');
}

export function consecutiveLookupFailures(samples) {
  const network = samples.filter(sample => !localLookupFailure(sample));
  const last = network.slice(-3);
  return last.length === 3 && last.every(sample => !sample.connected && (sample.providerFailure ?? providerLookupFailure(sample)));
}
