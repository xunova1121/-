/** 只在本次操作期间监听上游取消信号，兼容缺少 AbortSignal 静态方法的 WebView。 */
export async function withAbortSignals(signals, work, timeoutMs = 0) {
  const controller = new AbortController();
  const forward = event => controller.abort(event.target.reason);
  let timer;
  try {
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) throw signal.reason ?? new DOMException('已停止', 'AbortError');
      signal.addEventListener('abort', forward, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
    }
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    for (const signal of signals) signal?.removeEventListener('abort', forward);
  }
}

/** 传输实现忽略signal时调用方仍能停止；无法撤销服务端已接收的操作。 */
export async function abortableFetch(fetchImpl, url, init) {
  const signal = init.signal;
  if (!signal) return fetchImpl(url, init);
  const reason = () => signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' });
  let abort;
  const stopped = new Promise((resolve, reject) => {
    abort = () => reject(reason());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const work = Promise.resolve().then(() => {
    if (signal.aborted) throw reason();
    return fetchImpl(url, init);
  }).then((response) => {
    if (signal.aborted) {
      // 迟到响应不能交给业务层；清理的次级错误不覆盖原停止信号。
      try {
        const cancelled = response.body?.cancel?.();
        cancelled?.catch?.(() => {});
      } catch {}
      throw reason();
    }
    return response;
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
