import { cardFields, cardMetrics, isDiagramCard } from './diagramCards.js';
const invalid = text => Object.assign(new Error(text), { code: 'DIAGRAM_INPUT', kind: 'input' });
const short = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw invalid(label + '为空或过长');
  return value.trim();
};

/** 最多8层、60节点、100连线；坐标由程序计算，模型不能随意指定而造成遮挡。 */
export function layoutDiagram(input) {
  const title = short(input.title, 80, '标题');
  if (!Array.isArray(input.layers) || !input.layers.length || input.layers.length > 8) throw invalid('架构图需1～8层');
  const ids = new Set();
  let count = 0;
  const layers = input.layers.map(layer => {
    if (!Array.isArray(layer.nodes) || !layer.nodes.length || layer.nodes.length > 12) throw invalid('每层需1～12个节点');
    const nodes = layer.nodes.map(node => {
      const id = short(node.id, 64, '节点ID');
      if (ids.has(id) || ++count > 60) throw invalid('节点ID重复或总数超过60');
      ids.add(id);
      return { id, title: short(node.title, 48, '节点标题'), detail: node.detail ? short(node.detail, 160, '节点说明') : '', ...cardFields(node) };
    });
    return { title: short(layer.title, 48, '层级标题'), emphasis: layer.emphasis === true, nodes };
  });
  const edges = input.edges || [];
  if (!Array.isArray(edges) || edges.length > 100) throw invalid('连线最多100条');
  const edgeIds = new Set();
  const edgeLabels = new Map();
  const cleanEdges = edges.map(edge => {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) throw invalid('连线引用了不存在的节点或自身');
    const key = edge.from + '\u0000' + edge.to;
    if (edgeIds.has(key)) {
      if (edgeLabels.get(key) !== (edge.label ?? '')) throw invalid('重复连线标签冲突，请保留一个明确标签');
      return null;
    }
    edgeLabels.set(key, edge.label ?? '');
    edgeIds.add(key);
    return { from: edge.from, to: edge.to, ...(edge.label !== undefined ? { label: short(edge.label, 12, '连线标签') } : {}) };
  }).filter(Boolean);
  const width = 1440;
  const padding = 48;
  const titleRows = Math.ceil([...title].length / 44);
  let y = input.design?.message ? titleRows > 1 ? 160 : 128 : titleRows > 1 ? 136 : 112;
  const ordered = input.direction === 'top-down' ? layers : [...layers].reverse();
  for (const layer of ordered) {
    layer.y = y;
    const flow = cleanEdges.some(edge => edge.label && layer.nodes.some(node => node.id === edge.from));
    const rich = layer.nodes.some(isDiagramCard);
    const columns = Math.min(layer.nodes.length, flow || rich ? 3 : 4);
    layer.rows = Math.ceil(layer.nodes.length / columns);
    const gap = flow ? 112 : 16;
    const boxWidth = (1128 - (columns - 1) * gap) / columns;
    const lineCount = (text, size) => Math.ceil([...text].reduce((sum, letter) => sum + (/[\u0000-\u007f]/.test(letter) ? 0.58 : 1), 0) / ((boxWidth - 36) / size));
    const rowHeight = Math.max(76, ...layer.nodes.map(node => isDiagramCard(node) ? cardMetrics(node, boxWidth).height : 28 + Math.min(2, lineCount(node.title, 20)) * 28 + (node.detail ? 12 + Math.min(3, lineCount(node.detail, 15)) * 21 : 0)));
    layer.height = Math.max(112, 32 + layer.rows * rowHeight + (layer.rows - 1) * 24);
    layer.nodes.forEach((node, index) => Object.assign(node, { x: 240 + (index % columns) * (boxWidth + gap), y: y + 16 + Math.floor(index / columns) * (rowHeight + 24), width: boxWidth, height: rowHeight }));
    y += layer.height + 36;
  }
  const nodes = ordered.flatMap(layer => layer.nodes);
  // 跨层通道在右侧，按需扩画布，不压缩节点字号。
  const model = { title, width: width + (cleanEdges.length ? 80 : 0), height: y + 12, layers: ordered, nodes, edges: cleanEdges, padding };
  for (const edge of cleanEdges.filter(item => item.label)) {
    const layer = ordered.find(item => item.nodes.some(node => node.id === edge.from));
    const from = layer.nodes.findIndex(node => node.id === edge.from);
    const to = layer.nodes.findIndex(node => node.id === edge.to);
    if (to < 0 || Math.abs(from - to) !== 1 || layer.nodes[from].y !== layer.nodes[to].y)
      throw invalid('带字箭头目前仅支持同层同排相邻节点，请将跨层关系单独列图');
    if (cleanEdges.some(other => other.from === edge.to && other.to === edge.from)) throw invalid('同一卡片间不能放双向重叠箭头，请合并为一个明确流程');
  }
  validateDiagramLayout(model);
  return model;
}

export function validateDiagramLayout(model) {
  for (const node of model.nodes) {
    if (node.x < 0 || node.y < 0 || node.x + node.width > model.width || node.y + node.height > model.height) throw invalid('节点超出画布');
    for (const other of model.nodes) {
      if (node.id === other.id) continue;
      if (node.x < other.x + other.width && node.x + node.width > other.x && node.y < other.y + other.height && node.y + node.height > other.y) throw invalid('节点重叠');
    }
  }
  return true;
}
