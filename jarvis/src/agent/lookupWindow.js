// 正式发布：普通查询预留收尾，预算不足时不再发起新请求。
/** 总时限不变，提前结束检索，给最后整理保留15秒；所有阶段共用同一时钟。 */
export const SUMMARY_RESERVE_MS = 15_000;
export const QUICK_MODEL_ATTEMPTS = 3;

/** 到点时正在写答案：只要还在连续出字（两段之间不超过 WRITING_GAP_MS），最多再宽限 WRITING_GRACE_MS，把话写完 */
export const WRITING_GRACE_MS = 30_000;
export const WRITING_GAP_MS = 6_000;
const RECHECK_MS = 1_000;

export function createLookupWindow({ totalMs, now = Date.now, disabled = () => false }) {
  const started = now();
  let lastText = -Infinity;
  const reserve = Math.min(SUMMARY_RESERVE_MS, Math.max(1, totalMs / 4));
  const remaining = () => (disabled() ? Infinity : Math.max(0, totalMs - (now() - started)));
  return {
    remaining,
    retrievalRemaining: () => Math.max(0, remaining() - reserve),
    /** 收到一段答案文字 */
    wrote: () => { lastText = now(); },
    /** 还在写、且没超出宽限（slack：外层总时限比内层多等一会儿，让内层先体面收尾） */
    writing: (slack = 0) => now() - lastText < WRITING_GAP_MS && now() - started < totalMs + WRITING_GRACE_MS + slack
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
      // 正在写答案：先不掐，过一秒再看
      if (control.writing?.()) { timer = setTimeout(expire, RECHECK_MS); return; }
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
