import { isRetrievalStop } from '../../shared/retrievalStop.js';

/**
 * 一轮里失败的步骤：工具名 + 报错原话（截短），存进这条回答的 failures。
 * 用户 2026-10-29：画图失败后问“你咋失败了 / 为啥做不下去”，未央只看得到自己最后那段总结，答不到点子上——
 * 那一轮每一步的报错只在任务进度记录里，下一句话一来就被新任务换掉了。
 */
export const FAILED_STEP_CHARS = 200;

export const failedStep = (event) => isRetrievalStop(event) ? null : ({ tool: String(event.name || '').slice(0, 60), error: String(event.output ?? event.error ?? '').replace(/\s+/g, ' ').slice(0, FAILED_STEP_CHARS) });

/** 最近一条带失败步骤的回答（只看最近 4 条消息，旧的不再带） */
export function recentFailures(history = []) {
  const last = history.slice(-4).reverse().find((m) => m.role === 'assistant' && Array.isArray(m.failures) && m.failures.length);
  if (!last) return '';
  const lines = last.failures.slice(-6).map((f) => `- ${f.tool}：${f.error}`);
  return `## 上一轮失败的步骤（工具回执原话；用户问为什么失败时据此回答具体原因，不要泛泛而谈）\n${lines.join('\n')}`;
}

/**
 * 最近几轮的执行记录（用户 2026-11-01：问“为啥刚才查不到”，未央编了个“没先问城市”；问“为啥慢”，说“看不到后台耗时”）。
 * 带上最近 3 条回答的真实耗时、首字时间、工具次数和失败步骤；并规定：问原因只按记录答，记录里没有就说没有，不许猜。
 */
const sec = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}秒` : '');
export function recentWorkLog(history = []) {
  const rows = history.slice(-8).filter((m) => m.role === 'assistant' && (m.timing || m.failures?.length)).slice(-3);
  if (!rows.length) return '';
  const lines = rows.map((m) => {
    const t = m.timing || {};
    const when = m.ts ? new Date(m.ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    const facts = [t.totalMs != null && `总耗时${sec(t.totalMs)}`, t.firstTextMs != null && `首字${sec(t.firstTextMs)}`, t.contextMs >= 300 && `准备上下文${sec(t.contextMs)}`, t.modelMs != null && `等模型${sec(t.modelMs)}`, t.toolCalls && `工具${t.toolCalls}次`, t.failedTools && `失败${t.failedTools}次`, t.retries && `重试${t.retries}次`, t.fallbacks && `换备用模型${t.fallbacks}次`].filter(Boolean).join('，');
    const fails = (m.failures || []).slice(-4).map((f) => `${f.tool}：${f.error}`).join('；');
    // 换了哪个模型：A → B（原因），按发生顺序（用户 2026-11-03：只记“换备用模型2次”，问换成谁答不上来）
    const swaps = (t.fallbackSteps || []).map((f) => `${f.from} → ${f.to}${f.reason ? `（${f.reason}）` : ''}`).join('；');
    return `- ${when ? when + ' ' : ''}回答“${String(m.content || '').replace(/\s+/g, ' ').slice(0, 30)}…”${facts ? `：${facts}` : ''}${swaps ? `；换模型经过：${swaps}` : ''}${fails ? `；失败步骤：${fails}` : ''}`;
  });
  return `## 最近几轮的执行记录（系统真实记录）\n${lines.join('\n')}\n用户问“为什么慢 / 为什么查不到 / 为什么失败”时，只按这些记录说具体原因；记录里没有的就说“记录里看不到原因”，不许猜测，也不要把失败编成自己的操作失误。`;
}
