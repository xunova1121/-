/**
 * 一轮里失败的步骤：工具名 + 报错原话（截短），存进这条回答的 failures。
 * 用户 2026-10-29：画图失败后问“你咋失败了 / 为啥做不下去”，未央只看得到自己最后那段总结，答不到点子上——
 * 那一轮每一步的报错只在任务进度记录里，下一句话一来就被新任务换掉了。
 */
export const FAILED_STEP_CHARS = 200;

export const failedStep = (event) => ({ tool: String(event.name || '').slice(0, 60), error: String(event.output ?? event.error ?? '').replace(/\s+/g, ' ').slice(0, FAILED_STEP_CHARS) });

/** 最近一条带失败步骤的回答（只看最近 4 条消息，旧的不再带） */
export function recentFailures(history = []) {
  const last = history.slice(-4).reverse().find((m) => m.role === 'assistant' && Array.isArray(m.failures) && m.failures.length);
  if (!last) return '';
  const lines = last.failures.slice(-6).map((f) => `- ${f.tool}：${f.error}`);
  return `## 上一轮失败的步骤（工具回执原话；用户问为什么失败时据此回答具体原因，不要泛泛而谈）\n${lines.join('\n')}`;
}
