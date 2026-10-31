/** 区县解析最多等 4 秒；位置变更后取消旧解析，迟到响应不能覆盖新城市。 */
export async function resolveWeatherLocation(lookup, signal) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(() => controller.abort(new Error('区县解析超时')), 4000);
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const work = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason;
    return lookup(controller.signal);
  });
  try { return await Promise.race([work, cancelled]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    controller.signal.removeEventListener('abort', abort);
  }
}
