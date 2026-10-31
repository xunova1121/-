/** 分层解释由已登记职责推导，不从名称猜角色；最多60对象、100关系，底稿校验后使用。 */
export const BUSINESS_ROLES = [
  ['infrastructure', '基础设施', '提供计算、存储、网络等运行资源，不等同业务功能'],
  ['acquisition', '感知与接入', '采集现场信号、接入与质量处理，产出上层可用输入'],
  ['data', '数据资源', '事件、证据等信息对象及其组织，不把数据库软件当业务数据'],
  ['capability', '共用能力', '可复用的服务能力，支撑业务活动'],
  ['application', '业务应用', '执行研判、派单、处置等业务活动，说明输入和结果'],
  ['interface', '用户与展示', '面向用户的操作入口和展示，不替代后台处理'],
  ['security', '贯穿保障', '权限、审计等横向保障，不当成一条上下游业务流水线']
];
export function architectureBusinessSummary(plan) {
  const owners = new Map(plan.relations.filter(item => item.type === 'contains').map(item => [item.to, item.from]));
  const entities = new Map(plan.entities.map(item => [item.id, item]));
  const layers = BUSINESS_ROLES.map(([role, title, meaning]) => ({ role, title, meaning, entities: plan.entities.filter(item => item.kind === role).map(item => ({ id: item.id, title: item.title, owner: owners.get(item.id) || null })) })).filter(item => item.entities.length);
  const systems = plan.entities.filter(item => item.kind === 'system').map(item => ({ id: item.id, title: item.title, owner: owners.get(item.id) || null }));
  const boundaries = plan.entities.filter(item => !owners.has(item.id) && item.kind !== 'system' && item.kind !== 'security').map(item => item.id);
  return {
    layers, systems, unassigned: boundaries,
    workflowCount: plan.relations.filter(item => item.type === 'workflow').length,
    feedbackCount: plan.relations.filter(item => item.type === 'feedback').length,
    note: '按已登记角色自下而上列出；系统是归属边界，安全是贯穿项，不强迫凑齐各层。未声明归属不等于归属错误，需按材料核实；登记闭环数不代表业务完整性已通过。',
    names: Object.fromEntries([...entities].map(([id, item]) => [id, item.title]))
  };
}
export function architectureBusinessMarkdown(plan) {
  const summary = architectureBusinessSummary(plan);
  const safe = value => String(value).replace(/[|\n\r]/g, ' ');
  const lines = ['## 自下而上分层与系统边界', '', summary.note, '', '| 层次 | 职责边界 | 已登记对象 |', '|---|---|---|'];
  for (const layer of summary.layers) lines.push(`| ${layer.title} | ${layer.meaning} | ${layer.entities.map(item => safe(item.title) + (item.owner ? '（归属：' + safe(summary.names[item.owner]) + '）' : '（归属未声明）')).join('；')} |`);
  lines.push('', '系统边界：' + (summary.systems.map(item => safe(item.title) + (item.owner ? '（归属：' + safe(summary.names[item.owner]) + '）' : '')).join('；') || '未登记，不能从名称推断'), '', `已登记业务流${summary.workflowCount}条、反馈${summary.feedbackCount}条；数据传输和支撑另按关系表核对。`);
  return lines.join('\n');
}
