import { errorKind } from './suggest.js';
import { retryWait } from '../llm/openai.js';
import { withWebDeadline } from '../agent/retrievalBudget.js';

/** 取消、任务预算是控制信号，任何降级都不能把它们变成“没有结果”。 */
export function throwControl(error, signal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' });
  if (error?.name === 'AbortError' || error?.code === 'RETRIEVAL_BUDGET') throw error;
}

export function httpError(httpStatus, detail = '', service = '网络服务') {
  return Object.assign(new Error(service + '返回 ' + httpStatus + (detail ? '：' + String(detail).slice(0, 200) : '')), {
    name: 'ApiError',
    kind: 'api',
    status: httpStatus,
    code: httpStatus === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR'
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' }));
    };
    if (signal?.aborted) return abort();
    timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** 仅用于幂等读取，包含正文读取；最多重试一次，绝不用于写入、付款、发送。 */
export async function retryRead(work, { signal, timeoutMs = 6000, beforeAttempt, onRetry, delayMs = 250 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    throwControl(null, signal);
    // 请求和重试都必须先取得预算，预算错误不进入网络重试。
    beforeAttempt?.(attempt);
    try {
      return await withWebDeadline(work, { signal, timeoutMs });
    } catch (error) {
      throwControl(error, signal);
      if (attempt || !['timeout', 'network'].includes(errorKind(error))) throw error;
      onRetry?.(error);
      await wait(retryWait(delayMs, error), signal);
    }
  }
}
