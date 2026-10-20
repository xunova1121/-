// 正式发布：普通查询预留收尾，预算不足时不再发起新请求。
/** 总时限不变，提前结束检索，给最后整理保留15秒；所有阶段共用同一时钟。 */
export const SUMMARY_RESERVE_MS = 15_000;
export const QUICK_MODEL_ATTEMPTS = 3;

export function createLookupWindow({ totalMs, now = Date.now, disabled = () => false }) {
  const started = now();
  const reserve = Math.min(SUMMARY_RESERVE_MS, Math.max(1, totalMs / 4));
  const remaining = () => (disabled() ? Infinity : Math.max(0, totalMs - (now() - started)));
  return {
    remaining,
    retrievalRemaining: () => Math.max(0, remaining() - reserve)
  };
}

/** 即使上游忽略取消也按阶段返回；取消只作用于当前模型请求。 */
export function modelWindow(control, closing, controller) {
  let timer;
  let onAbort;
  const expired = new Promise((resolve, reject) => {
    onAbort = () => reject(controller.signal.reason || Object.assign(new Error('已停止'), { name: 'AbortError' }));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const delay = closing ? control?.remaining() - 1000 : control?.retrievalRemaining();
    if (!Number.isFinite(delay)) return;
    const expire = () => {
      if (!Number.isFinite(control.remaining())) return;
      const error = Object.assign(new Error(closing ? '答案整理时间已用完' : '已预留时间整理现有资料'), {
        name: 'LookupPhaseError',
        kind: 'timeout',
        code: closing ? 'LOOKUP_SUMMARY_TIMEOUT' : 'LOOKUP_RETRIEVAL_END'
      });
      controller.abort(error);
      reject(error);
    };
    if (delay <= 0) expire();
    else timer = setTimeout(expire, delay);
  });
  // 允许请求前已过期；即使调用方尚未进入race也不产生未处理拒绝。
  expired.catch(() => {});
  return {
    race: (work) =>
      controller.signal.aborted
        ? Promise.reject(controller.signal.reason)
        : Promise.race([
            typeof work === 'function'
              ? Promise.resolve().then(() => {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  return work();
                })
              : work,
            expired
          ]),
    dispose: () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
}
