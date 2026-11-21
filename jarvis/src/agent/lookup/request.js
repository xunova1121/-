/** 覆盖请求及正文读取；即使某个平台忽略 signal，也及时返回，并阻止后续重试。 */
export async function withWebDeadline(work, { signal, timeoutMs = 12_000 } = {}) {
  const ctrl = new AbortController();
  let timer, rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = signal?.aborted
      ? Object.assign(new Error('已停止读取网页'), { name: 'AbortError' })
      : Object.assign(new Error('网页请求超时，请换一个来源'), { name: 'TimeoutError' });
    ctrl.abort(error); rejectAbort(error);
  };
  if (signal?.aborted) abort();
  else { signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, Math.max(1, timeoutMs)); }
  try { return await Promise.race([cancelled, Promise.resolve().then(() => { if (ctrl.signal.aborted) throw ctrl.signal.reason; return work(ctrl.signal); })]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}


