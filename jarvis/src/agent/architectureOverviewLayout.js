function primaryCard(item, index, node) {
  const result = node(item, index);
  const bullets = [item.responsibility, ...(item.inputs.length ? ['输入：' + item.inputs.join('、')] : []), ...(item.outputs.length ? ['输出：' + item.outputs.join('、')] : [])];
  if (bullets.length >= 2 && bullets.every(text => [...text].length <= 80)) {
    result.detail = '';
    result.bullets = bullets.map(text => ({ text }));
  }
  return result;
}
/** 总览保留业务主线，次要模块只列名称；职责原文保留在同一业务底稿，不改业务数据。 */
export function overviewApplicationSections(values, plan, group, view, node) {
  if (view !== 'overview' || !group || values.length < 8 || values.length > 18) return null;
  const flows = plan.relations.filter(item => ['workflow', 'feedback'].includes(item.type));
  const detailed = new Set(flows.flatMap(item => [item.from, item.to]));
  // 总览支撑关系用卡片说明，不能把支撑发起方塞进无正文网格而丢关系。
  for (const relation of plan.relations) if (relation.type === 'supports') detailed.add(relation.from);
  const primary = values.filter(item => detailed.has(item.id));
  const secondary = values.filter(item => !detailed.has(item.id));
  if (secondary.length < 8 || primary.length > 3) return null;
  const ordered = workflowOrder(primary, plan.relations);
  if (!ordered) return null;
  return [
    ...(ordered.length ? [{ title: '业务应用｜主流程', role: 'application', kind: 'cards', group: group.title, nodes: ordered.map((item, index) => primaryCard(item, index, node)) }] : []),
    { title: '业务应用｜模块组成', role: 'application', kind: 'grid', group: group.title, nodes: secondary.map(item => ({ id: item.id, title: item.title })) }
  ];
}

/** 层数紧张时在同一个业务职责层归拢主线、关联卡片和组成，不删除对象或它们的关系。 */
export function overviewApplicationCatalog(values, plan, group, view, node) {
  if (view !== 'overview' || values.length < 8 || values.length > 18) return null;
  const protectedIds = new Set(plan.relations.filter(item => ['workflow', 'feedback', 'integration'].includes(item.type)).flatMap(item => [item.from, item.to]));
  for (const relation of plan.relations) if (relation.type === 'supports') protectedIds.add(relation.from);
  const detailed = workflowOrder(values.filter(item => protectedIds.has(item.id)), plan.relations);
  if (!detailed || detailed.length > 15) return null;
  const primary = detailed.slice(0, 3), related = detailed.slice(3);
  const modules = values.filter(item => !protectedIds.has(item.id));
  return [{
    title: '业务应用', role: 'application', kind: 'catalog', ...(group && { group: group.title }),
    catalog: { primary: primary.map(item => item.id), detailed: related.map(item => item.id) },
    nodes: [...primary.map((item, index) => primaryCard(item, index, node)), ...related.map(node), ...modules.map(item => ({ id: item.id, title: item.title }))]
  }];
}

/** 仅用已登记的业务推进排序，反馈不参与；循环交原审查处理，不猜顺序。 */
export function workflowOrder(values, relations) {
  const ids = new Set(values.map(item => item.id));
  const pending = [...values], ordered = [];
  while (pending.length) {
    const index = pending.findIndex(item => !relations.some(link => link.type === 'workflow' && link.to === item.id && ids.has(link.from) && pending.some(parent => parent.id === link.from)));
    if (index < 0) return null;
    ordered.push(...pending.splice(index, 1));
  }
  return ordered;
}
