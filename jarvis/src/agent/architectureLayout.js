import { overviewApplicationSections, overviewApplicationCatalog } from './architectureOverviewLayout.js';
/** 新底稿的业务版式。只组合已经审查的对象/关系，不添加业务、删证据或压小字号。 */
const roles = ['interface', 'system', 'application', 'capability', 'data', 'acquisition', 'infrastructure', 'security'];
const labels = { interface: '用户与展示', system: '系统与边界', application: '业务应用', capability: '共用能力', data: '数据资源', acquisition: '感知与接入', infrastructure: '基础设施', security: '贯穿保障' };
const icons = { interface: 'layout-grid', system: 'layers', application: 'clipboard-check', capability: 'network', data: 'database', acquisition: 'target', infrastructure: 'cpu' };
const invalid = message => Object.assign(new Error(message), { code: 'ARCHITECTURE_LAYOUT_CAPACITY', kind: 'input', diagnostics: [{ stage: 'layout', field: 'layers', action: '按系统边界选择总体与专题视图；保留全部对象/关系，不压缩原文或改小字号硬塞' }] });
export function businessArchitectureLayout(plan, input = {}) {
  const owners = new Map(plan.relations.filter(item => item.type === 'contains').map(item => [item.to, item.from]));
  const endpoints = new Set(plan.relations.filter(item => item.type !== 'contains').flatMap(item => [item.from, item.to]));
  const groups = plan.entities.filter(item => item.kind === 'system' && !endpoints.has(item.id) && plan.relations.some(link => link.type === 'contains' && link.from === item.id && plan.entities.some(child => child.id === link.to && child.kind !== 'system')));
  if (groups.length > 3) throw invalid('系统分组超过3个，请按系统边界拆分总体与专题');
  const grouped = new Set(groups.map(item => item.id));
  const groupFor = entity => {
    if (entity.kind === 'interface' || entity.kind === 'security') return null; // 展示/保障独立呈现，原归属由投影标记保留。
    let parent = owners.get(entity.id);
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      if (grouped.has(parent)) return parent;
      seen.add(parent); parent = owners.get(parent);
    }
    return null;
  };
  const node = (item, index) => ({ id: item.id, title: item.title, detail: item.responsibility, ...(icons[item.kind] && { icon: icons[item.kind] }), ...(item.kind === 'application' && { accent: ['orange', 'blue', 'green'][index % 3] }) });
  const layers = [];
  let composite = false;
  const append = (entities, group) => {
    for (const role of roles) {
      const values = entities.filter(item => item.kind === role);
      const catalog = composite && role === 'application' && overviewApplicationCatalog(values, plan, group, input.view || 'overview', node);
      if (catalog) { layers.push(...catalog); continue; }
      const overview = role === 'application' && overviewApplicationSections(values, plan, group, input.view || 'overview', node);
      if (overview) { layers.push(...overview); continue; }
      for (let offset = 0; offset < values.length; offset += 12) {
        const part = values.slice(offset, offset + 12);
        const kind = role === 'security' && part.length === 1 ? 'band' : ['interface', 'infrastructure'].includes(role) && part.length >= 2 && part.length <= 4 ? 'columns' : 'cards';
        layers.push({ title: labels[role], role, kind, ...(group && { group: group.title }), nodes: part.map(node) });
      }
    }
  };
  let visible = plan.entities.filter(item => !grouped.has(item.id));
  let outside = visible.filter(item => !groupFor(item));
  const build = () => {
    append(outside.filter(item => ['interface', 'system'].includes(item.kind)));
    for (const group of groups) append(visible.filter(item => groupFor(item) === group.id), group);
    append(outside.filter(item => !['interface', 'system'].includes(item.kind)));
    // 没有可视子项的分组仍以独立系统节点呈现，避免隐藏空容器。
    for (const group of groups) if (!layers.some(layer => layer.group === group.title)) append([group]);
  };
  build();
  if (layers.length > 8 && (input.view || 'overview') === 'overview') { composite = true; layers.length = 0; build(); }
  // 密集业务已经组成同职责组合层时，零散容器不能再各占一整职责层；保留系统节点，以既有C编号逐项表达归属。
  if (composite && layers.length > 8 && layers.some(layer => layer.kind === 'catalog')) {
    groups.length = 0; grouped.clear(); visible = [...plan.entities]; outside = visible; layers.length = 0; build();
  }
  const topic = ['workflow', 'dataflow'].includes(input.view);
  // 专题先按原投影核对完整对象，再筛对应关系端点；最终布局仍执行原8层限制。
  if (!layers.length || !topic && layers.length > 8) throw invalid('当前内容与系统边界超过单图8层容量，请拆分总体和专题，不省略对象');
  return { ...input, title: input.title || plan.title, layers, view: input.view || 'overview', direction: 'top-down', design: { theme: 'gov-blue', message: '业务职责 · 系统边界 · 支撑与闭环', ...(input.design || {}) } };
}
