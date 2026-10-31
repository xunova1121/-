import { withWebDeadline } from './request.js';
import { failureKind } from './recoveryData.js';
/** 单源额度内一次短重试；鉴权/配额/参数/用户停止不重复请求。 */
export async function shortSourceRetry(work, { signal, beforeRetry } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw signal.reason;
    try { return await withWebDeadline(work, { signal, timeoutMs: attempt ? 1500 : 3500 }); }
    catch (error) {
      if (signal?.aborted || attempt || failureKind(error) !== 'transient') throw error;
      beforeRetry?.();
    }
  }
}
