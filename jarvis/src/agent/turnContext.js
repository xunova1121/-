/**
 * 一轮任务中途的上下文瘦身：步骤多了，前面工具返回的大段原文（网页、文件、搜索结果、截图）会把上下文撑满，
 * 模型变慢、变笨，甚至超出上限报错。超过预算时，把较早的工具结果缩成开头一段 + 说明，最近几条原样保留；
 * 较早的截图只留最近两张。需要原文时模型可以再调用一次工具。只改这一轮的工作副本，不影响保存的对话。
 */
export const TURN_BUDGET = 60_000; // 工具结果合计超过这么多字才瘦身
export const KEEP_RECENT = 6; // 最近几条工具结果原样保留
export const SHORT = 800; // 较早的结果保留开头这么多字

export function compactToolResults(convo, { budget = TURN_BUDGET, keep = KEEP_RECENT, short = SHORT } = {}) {
  const tools = convo.filter((m) => m.role === 'tool');
  const total = tools.reduce((n, m) => n + String(m.content ?? '').length, 0);
  let saved = 0;
  if (total > budget) {
    for (const m of tools.slice(0, -keep)) {
      const text = String(m.content ?? '');
      if (m.compacted || text.length <= short * 1.5) continue;
      m.content = `${text.slice(0, short)}\n…（这是较早的工具结果，为节省上下文已缩短，原文共 ${text.length} 字；还需要细节就再调用一次工具）`;
      m.compacted = true;
      saved += text.length - m.content.length;
    }
  }
  // 截图、图片很占上下文：只留最近两条带图的工具结果
  const withImages = tools.filter((m) => m.images?.length);
  for (const m of withImages.slice(0, -2)) { delete m.images; m.content = `${m.content}\n（较早的截图已省略）`; }
  return { total, saved };
}
