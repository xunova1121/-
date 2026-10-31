const fits = value => typeof value === 'string' && value.trim() && [...value].length <= 12;

/** 标签只用已登记的精确数据名；歧义或长名称不缩写、不从meaning猜数据。 */
export function architectureFlowLabel(plan, relationIndex) {
  const relation = plan.relations[relationIndex];
  if (relation?.type !== 'dataflow') return undefined;
  const from = plan.entities.find(entity => entity.id === relation.from), to = plan.entities.find(entity => entity.id === relation.to);
  const common = [...new Set((from?.outputs || []).filter(value => typeof value === 'string' && value.trim() && to?.inputs?.includes(value)))];
  const explicit = plan.compilation?.relationIntents?.find(row => row.index === relationIndex)?.data;
  const selected = common.includes(explicit) ? explicit : common.length === 1 ? common[0] : undefined;
  return fits(selected) ? selected : '数据流';
}
