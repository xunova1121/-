/** 相邻行在行间通道连线；跨行只走右侧独立通道，不穿标题或中间节点。 */
export function diagramRoutes(model) {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  const rows = [...new Set(model.nodes.map((node) => node.y))].sort((a, b) => a - b);
  let outer = 0;
  return model.edges.map((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const a = { x: from.x + from.width / 2, y: from.y };
    const b = { x: to.x + to.width / 2, y: to.y };
    let points;
    if (edge.label) {
      const forward = from.x < to.x;
      points = [{ x: forward ? from.x + from.width + 4 : from.x - 4, y: from.y + from.height / 2 }, { x: forward ? to.x - 4 : to.x + to.width + 4, y: to.y + to.height / 2 }];
    } else if (from.y === to.y) {
      const gap = from.y - 8;
      points = [a, { x: a.x, y: gap }, { x: b.x, y: gap }, b];
    } else {
      const upward = from.y > to.y;
      if (!upward) a.y += from.height;
      if (upward) b.y += to.height;
      if (!model.structured && Math.abs(rows.indexOf(from.y) - rows.indexOf(to.y)) === 1) {
        const middle = (a.y + b.y) / 2;
        points = [a, { x: a.x, y: middle }, { x: b.x, y: middle }, b];
      } else {
        // 右侧每条跨层连线单独占用6px，超过16条请拆分为专题图。
        if (++outer > 16) throw Object.assign(new Error('跨层关系超过16条，请拆分总体架构与详细关系图'), { code: 'DIAGRAM_EDGE_DENSITY', kind: 'input' });
        const x = 1408 + outer * 6;
        const first = a.y + (upward ? -8 : 8);
        const last = b.y + (upward ? 8 : -8);
        points = [a, { x: a.x, y: first }, { x, y: first }, { x, y: last }, { x: b.x, y: last }, b];
      }
    }
    return { ...edge, points, path: points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ') };
  });
}
