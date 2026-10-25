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
      return { id, title: short(node.title, 48, '节点标题'), detail: node.detail ? short(node.detail, 160, '节点说明') : '' };
    });
    return { title: short(layer.title, 48, '层级标题'), emphasis: layer.emphasis === true, nodes };
  });
  const edges = input.edges || [];
  if (!Array.isArray(edges) || edges.length > 100) throw invalid('连线最多100条');
  const cleanEdges = edges.map(edge => {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) throw invalid('连线引用了不存在的节点或自身');
    return { from: edge.from, to: edge.to };
  });
  const width = 1440;
  const padding = 64;
  let y = 128;
  const ordered = input.direction === 'top-down' ? layers : [...layers].reverse();
  for (const layer of ordered) {
    layer.y = y;
    layer.rows = Math.ceil(layer.nodes.length / 4);
    const columns = Math.min(layer.nodes.length, 4);
    const boxWidth = (width - padding * 2 - 48 - (columns - 1) * 20) / columns;
    const lineCount = (text, size) => Math.ceil([...text].reduce((sum, letter) => sum + (/[\u0000-\u007f]/.test(letter) ? 0.58 : 1), 0) / ((boxWidth - 36) / size));
    const rowHeight = Math.max(80, ...layer.nodes.map(node => node.detail ? 112 + Math.min(2, lineCount(node.detail, 15) - 1) * 21 : 70 + Math.min(1, lineCount(node.title, 21) - 1) * 30));
    layer.height = 80 + layer.rows * rowHeight + (layer.rows - 1) * 20;
    layer.nodes.forEach((node, index) => Object.assign(node, { x: padding + 24 + (index % 4) * (boxWidth + 20), y: y + 56 + Math.floor(index / 4) * (rowHeight + 20), width: boxWidth, height: rowHeight }));
    y += layer.height + 48;
  }
  const nodes = ordered.flatMap(layer => layer.nodes);
  const model = { title, width, height: y + 16, layers: ordered, nodes, edges: cleanEdges };
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
