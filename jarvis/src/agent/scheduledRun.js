/**
 * 执行一次定时任务（与界面无关，main.js 负责建会话、保存和通知）：
 *
 *   - 卡住保护：连续 IDLE_MS 没有任何进展（新的输出、工具事件）就中断，记为失败。
 *     不只靠 signal：某个工具不理会中断时也照样返回，后面的定时任务不会被一直挡住
 *   - 模型没有给出任何内容：记为失败（“没有得到结果”）
 *   - 回复以【无需通知】开头：按任务要求这次不必打扰用户（如“降价了再告诉我”但还没降），结果照样保存
 */
export const IDLE_MS = 10 * 60_000;
export const QUIET_MARK = '【无需通知】';
export const TIMEOUT_NOTE = '连续 10 分钟没有进展，已中断';
export const EMPTY_NOTE = '没有得到结果';

/** 发给模型的任务说明 */
export function scheduledPrompt(s, when) {
  return `【这是定时任务「${s.title}」（${when}）自动发起的，用户此刻可能不在电脑前；直接完成任务并给出结果，不要提问。`
    + `如果按任务要求这次不需要通知用户（例如“降价了再告诉我”但还没降价），在回复开头写${QUIET_MARK}，再简单说明检查结果。】\n${s.prompt}`;
}

/** 解析回复：开头的【无需通知】去掉，并标记 quiet */
export function parseReply(text) {
  const t = String(text ?? '').trim();
  if (t.startsWith(QUIET_MARK)) return { quiet: true, text: t.slice(QUIET_MARK.length).trim() };
  return { quiet: false, text: t };
}

/**
 * 这次该发什么通知（null = 不发）：自动暂停 > 失败 > 正常结果；【无需通知】不发
 * @param {{ title: string }} s
 * @param {{ ok: boolean, quiet: boolean, text: string, note: string }} res  executeScheduled 的结果
 * @param {{ paused?: boolean, lastStatus?: string } | null} rec  scheduler.recordRun 的返回值
 */
export function notificationFor(s, { ok, quiet, text, note }, rec) {
  const title = `⏰ ${s.title}`;
  if (rec?.paused) return { title, body: `${rec.lastStatus}（最近一次：${note}）` };
  if (!ok) return { title, body: `失败：${note}` };
  if (quiet) return null;
  return { title, body: text.replace(/\s+/g, ' ') };
}

/**
 * @param {(o: { signal: AbortSignal, emit: (e: object) => void }) => Promise<{ text: string }>} run  调用 runAgent，并把 emit / signal 传进去
 * @param {{ idleMs?: number, onEvent?: (e: object) => void }} [o]
 * @returns {Promise<{ ok: boolean, quiet: boolean, text: string, note: string, timedOut: boolean }>}
 */
export async function executeScheduled(run, { idleMs = IDLE_MS, onEvent } = {}) {
  const ctrl = new AbortController();
  let timer;
  let stall;
  const stalled = new Promise((_, reject) => { stall = reject; });
  // 每个事件都算一次进展，重新计时
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ctrl.abort();
      stall(Object.assign(new Error(TIMEOUT_NOTE), { timedOut: true }));
    }, idleMs);
  };
  const emit = (e) => { arm(); onEvent?.(e); };
  arm();
  try {
    const r = await Promise.race([run({ signal: ctrl.signal, emit }), stalled]);
    const { quiet, text } = parseReply(r?.text);
    if (!text && !quiet) return { ok: false, quiet: false, text: '', note: EMPTY_NOTE, timedOut: false };
    return { ok: true, quiet, text, note: '', timedOut: false };
  } catch (e) {
    const timedOut = Boolean(e?.timedOut) || ctrl.signal.aborted;
    return { ok: false, quiet: false, text: '', note: timedOut ? TIMEOUT_NOTE : e?.message || String(e), timedOut };
  } finally {
    clearTimeout(timer);
  }
}
