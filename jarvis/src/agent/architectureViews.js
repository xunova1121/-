import { workflowOrder } from './architectureOverviewLayout.js';
/** 同一底稿的不同视图必须显式声明范围；不把某视图省略的关系当作删除或验收通过。 */
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_VIEW', kind: 'input' });
export function architectureView(plan, input) {
  const view = input.view || 'relations';
  if (!['overview', 'workflow', 'dataflow', 'relations'].includes(view)) throw invalid('视图类型无效');
  const byId = new Map(plan.entities.map((item) => [item.id, item]));
  const all = plan.relations.map((link, index) => ({ ...link, id: 'relation-' + index }));
  const coverage = all.map((link) => ({ id: link.id, type: link.type, display: link.type === 'contains' ? 'ownership' : link.type === 'integration' ? 'undirected_link' : 'arrow' }));
  const result = { ...input, view, relationCoverage: coverage };
  const findNode = (id) => result.layers.flatMap((layer) => layer.nodes).find((node) => node.id === id);
  if (view === 'overview') {
    for (const source of new Set(all.filter((link) => link.type === 'supports').map((link) => link.from))) {
      const node = findNode(source),
        layer = result.layers.find((item) => item.nodes.includes(node));
      if (!node || layer.kind === 'grid') throw invalid('对外支撑对象需独立卡片，不能在纯标题网格中省略支撑说明');
      const targets = all.filter((link) => link.type === 'supports' && link.from === source).map((link) => byId.get(link.to).title);
      const detail = [node.detail, '支撑：' + [...new Set(targets)].join('、')].filter(Boolean).join('；');
      if (detail.length > 160) throw invalid('支撑说明过密，请拆分总体与支撑专题，未截断关系');
      node.detail = detail;
    }
    const feedback = all.filter((link) => link.type === 'feedback');
    if (feedback.length) {
      const detail = feedback.map((link) => byId.get(link.from).title + ' → ' + byId.get(link.to).title + '：' + link.meaning).join('；');
      if (detail.length > 160) throw invalid('反馈闭环条超出版面，请用系统容器归拢层级或拆业务流程图，未丢弃反馈关系');
      const index = result.layers.findLastIndex((layer) => layer.role === 'application');
      const parent = result.layers[index];
      if (result.layers.length >= 8 && parent) parent.footer = { title: '反馈闭环', detail, relationIds: feedback.map(link => link.id) };
      else result.layers.splice(index + 1, 0, {
        title: '反馈闭环',
        role: 'application',
        kind: 'band',
        ...(parent?.group && { group: parent.group }),
        nodes: [{ id: '__architecture_feedback__', title: '反馈关系', detail }]
      });
    }
    result.edges = result.edges.filter((edge) => ['workflow', 'integration'].includes(edge.type));
    for (const item of coverage)
      if (item.type === 'supports') item.display = 'support_text';
      else if (item.type === 'feedback') item.display = 'feedback_band';
      else if (item.type === 'dataflow') item.display = 'dataflow_view';
    result.design = { ...result.design, audience: '总体架构：组成、归属、支撑与业务闭环；数据传输见数据流视图' + (result.layers.some(layer => ['grid', 'catalog'].includes(layer.kind)) ? '；网格列名称，职责见业务底稿' : '') };
  } else if (view === 'workflow' || view === 'dataflow') {
    const selected = all.filter((link) => (view === 'workflow' ? ['workflow', 'feedback'].includes(link.type) : link.type === 'dataflow'));
    if (!selected.length) throw invalid('底稿没有登记此视图的关系，请先补关系，不能编造连接');
    const ids = new Set(selected.flatMap((link) => [link.from, link.to]));
    result.layers = result.layers.map((layer) => ({ ...layer, nodes: layer.nodes.filter((node) => ids.has(node.id)) })).filter((layer) => layer.nodes.length);
    for (const layer of result.layers) {
      if (view === 'workflow') layer.nodes = workflowOrder(layer.nodes, selected) || layer.nodes;
      if ((layer.kind === 'columns' && layer.nodes.length === 1) || (layer.kind === 'grid' && layer.nodes.length < 8)) {
        if (layer.kind === 'grid') for (const node of layer.nodes) node.detail = byId.get(node.id).responsibility;
        layer.kind = 'cards';
        for (const node of layer.nodes)
          if (node.subtitle) {
            const detail = [node.subtitle, node.detail].filter(Boolean).join('；');
            if (detail.length > 160) throw invalid('专题视图的说明超出卡片容量，请调整版式，未截断原文');
            node.detail = detail;
            delete node.subtitle;
          }
      }
    }
    result.edges = result.edges
      .filter((edge) => selected.some((link) => link.id === edge.relationId))
      .map((edge) => ({ ...edge, label: view === 'dataflow' ? edge.label || '数据流' : edge.meaning.length <= 12 ? edge.meaning : '业务流' }));
    const selectedIds = new Set(selected.map((link) => link.id));
    for (const item of coverage)
      if (!selectedIds.has(item.id) && item.type !== 'contains') item.display = item.type === 'dataflow' ? 'dataflow_view' : 'overview_view';
    const suffix = view === 'workflow' ? '业务闭环' : '数据流';
    result.title = result.title + ' · ' + suffix;
    if (result.title.length > 80) throw invalid('视图标题超过80字，请提供简短标题，不截断项目名称');
    result.design = {
      ...result.design,
      message: view === 'workflow' ? '只表达业务活动及反馈；系统组成与支撑见总体图' : '只表达实际登记的数据传输；业务流程与支撑见其他视图'
    };
  }
  return result;
}
