/** 本地保守估算，不冒充服务商计费 token；未提供容量时用 32K 软预算。 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const wide = (text.match(/[^\x00-\x7f]/g) || []).length;
  return Math.ceil(wide + (text.length - wide) / 3);
}

export function contextBudget({ contextWindow = 32768, outputReserve = 8192, fixedTokens = 4096 } = {}) {
  const window = Math.max(8192, Math.min(1000000, Number(contextWindow) || 32768));
  const reserved = Math.min(window / 3, Math.max(1024, Number(outputReserve) || 8192));
  return Math.max(2048, Math.floor((window - reserved - fixedTokens) * 0.8));
}

/** 后台只做一次有界调用；前台开始后可取消，不重试、不启用原生联网。 */
export async function boundedSummaryCall(llm, input, { signal, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer, onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return llm({ ...input, signal: ctrl.signal, allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0 });
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        ctrl.signal.addEventListener('abort', onAbort, { once: true });
        if (ctrl.signal.aborted) onAbort();
        timer = setTimeout(() => {
          reject(Object.assign(new Error('摘要超过后台预算'), { code: 'SUMMARY_TIMEOUT' }));
          ctrl.abort();
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    ctrl.signal.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', abort);
  }
}
