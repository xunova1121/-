import { errorKind } from '../src/core/suggest.js';

export function evalError(message, code, kind = 'api', httpStatus) {
  return Object.assign(new Error(message), { code, kind, ...(httpStatus && { status: httpStatus }) });
}

/** 不传播响应正文、URL和任意错误文本；代码只保留已知枚举，防止凭据混入。 */
export function safeFailure(error, phase) {
  const kind = errorKind({ kind: error?.kind, name: error?.name, status: error?.status, code: error?.code, cause: { code: error?.cause?.code } });
  const known = new Set(['EVAL_HTTP', 'EVAL_PROTOCOL', 'EVAL_REQUEST_TIMEOUT', 'EVAL_INVALID_JSON', 'RETRIEVAL_BUDGET', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
  const code = error?.code || error?.cause?.code;
  return { phase, kind: error?.name === 'AbortError' ? 'aborted' : kind || 'unknown', code: known.has(code) ? code : null, httpStatus: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null };
}

/** 即使下一次轮询失败，也保存最后已取得的数值和短状态，不复制任务正文。 */
export function retainSnapshot(result, info) {
  if (!info) return;
  result.lastTaskState = { status: info.status, seq: info.seq ?? null, errorKind: info.errorKind || null };
  result.timing = info.timing ?? result.timing ?? null;
  result.usage = info.usage ?? result.usage ?? null;
  result.review = info.review ?? result.review ?? null;
  result.outcome = info.review?.outcome ?? result.outcome ?? 'not_checked';
  result.files = Array.isArray(info.files) ? info.files.slice(0, 100) : result.files || [];
}

/** 可取消的轮询间隔；不在网络错误后自动重发有副作用的POST。 */
export function pollWait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(Object.assign(new Error('评测已停止'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}
