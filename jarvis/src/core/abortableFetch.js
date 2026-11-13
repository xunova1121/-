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
