import { codeError } from './codeGit.mjs';

/** 元数据、clone/fetch及重试共用60秒，不让两次Git超时各等两分钟。 */
export async function withCodeNetworkDeadline(work, { signal, timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(() => controller.abort(codeError('CODE_GIT_TIMEOUT', '服务器连接GitHub不稳定：克隆/更新仓库已达到总时限，已停止；已有工作副本保留', { kind: 'timeout' })), Math.min(60000, Math.max(1, timeoutMs)));
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const operation = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    const result = await work(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  });
  try { return await Promise.race([operation, cancelled]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    controller.signal.removeEventListener('abort', abort);
  }
}
