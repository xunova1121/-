/** 调研按深度给一次性额度，包含规划、逐页摘录、轮间核对和最后成文；不是无限放开普通查询。 */
export const RESEARCH_BUDGETS = Object.freeze({
  quick: { durationMs: 90_000, search: 6, read: 8, model: 6 },
  standard: { durationMs: 180_000, search: 16, read: 16, model: 11 },
  deep: { durationMs: 300_000, search: 30, read: 28, model: 18 }
});

/** 只保留已取得的来源要点，不把中断称作完整报告，也不把整页正文塞回消息。 */
export function researchPartialEvidence(sources) {
  const rows = sources.filter(source => source.points?.length).slice(0, 8);
  if (!rows.length) return '';
  return ['调研未完成，以下是中断前取得的来源要点，尚未完成交叉核对：',
    ...rows.map(source => `${String(source.title || '').slice(0, 80)} ${String(source.url || '').slice(0, 250)}\n${source.points.slice(0, 2).map(point => String(point).slice(0, 220)).join('；')}`)
  ].join('\n').slice(0, 1800);
}
