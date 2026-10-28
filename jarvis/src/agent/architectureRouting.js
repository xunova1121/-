import { routeLabelPosition, labelBox, routeHitsBox } from './architectureRouteLabels.js';
import { diagramLines } from './diagramText.js';
const measure = (text, size) => [...text].reduce((sum, c) => sum + (/[\u0000-\u007f]/.test(c) ? 0.58 : 1), 0) * size;
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_ROUTE', kind: 'input' });
const segmentHits = (a, b, box) =>
  a.x === b.x
    ? a.x > box.x - 2 && a.x < box.x + box.width + 2 && Math.max(a.y, b.y) > box.y - 2 && Math.min(a.y, b.y) < box.y + box.height + 2
    : a.y > box.y - 2 && a.y < box.y + box.height + 2 && Math.max(a.x, b.x) > box.x - 2 && Math.min(a.x, b.x) < box.x + box.width + 2;
function obstacles(model) {
  const result = [];
  for (const layer of model.layers) {
    if (layer.kind === 'band') {
      for (const node of layer.nodes) {
        const lines = diagramLines([node.title, node.detail].filter(Boolean).join(' · '), (node.width - 32) / 15, 2);
        result.push({ x: node.x + 16, y: node.y + 12, width: Math.max(...lines.map((line) => measure(line, 15))), height: lines.length * 21 });
      }
    } else result.push(...layer.nodes.map((node) => ({ ...node, obstacleId: node.id })));
    if (layer.sideHeading) result.push({ x: 68, y: layer.y + 10, width: 154, height: Math.min(layer.height, 90) });
    else {
      const width = Math.min(1344, measure(layer.title, 17));
      result.push({ x: (1440 - width) / 2, y: layer.y + 5, width, height: 24 });
    }
  }
  for (const group of new Set(model.layers.map((layer) => layer.group).filter(Boolean))) {
    const first = model.layers.find((layer) => layer.group === group);
    const width = Math.min(1344, measure(group, 22));
    result.push({ x: (1440 - width) / 2, y: first.y - 50, width, height: 36 });
  }
  return result;
}
function simplify(points) {
  const result = [];
  for (const point of points) {
    if (result.length && result.at(-1).x === point.x && result.at(-1).y === point.y) continue;
    result.push(point);
    while (result.length >= 3) {
      const [a, b, c] = result.slice(-3);
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) result.splice(-2, 1);
      else break;
    }
  }
  return result;
}
const crossing = (a, b, c, d) =>
  a.x === b.x && c.y === d.y
    ? a.x > Math.min(c.x, d.x) && a.x < Math.max(c.x, d.x) && c.y > Math.min(a.y, b.y) && c.y < Math.max(a.y, b.y)
    : a.y === b.y && c.x === d.x
      ? crossing(c, d, a, b)
      : false;

/** 新底稿使用端口与障碍物选路，旧设计稿路由不变；最多100关系、每条最多300候选，不删边过关。 */
export function architectureRoutes(model) {
  const boxes = obstacles(model);
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  const used = [];
  const labels = [];
  const result = new Map();
  const ordered = model.edges
    .map((edge, index) => ({ ...edge, index }))
    .sort(
      (a, b) =>
        (a.type === 'workflow' ? -1 : 0) - (b.type === 'workflow' ? -1 : 0) ||
        Math.abs(nodes.get(a.from).y - nodes.get(a.to).y) - Math.abs(nodes.get(b.from).y - nodes.get(b.to).y)
    );
  for (const edge of ordered) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    const sameRow = from.y === to.y;
    const down = to.y > from.y;
    const a = sameRow
      ? { x: to.x > from.x ? from.x + from.width : from.x, y: from.y + from.height / 2 }
      : { x: from.x + from.width / 2, y: down ? from.y + from.height : from.y };
    const b = sameRow ? { x: to.x > from.x ? to.x : to.x + to.width, y: to.y + to.height / 2 } : { x: to.x + to.width / 2, y: down ? to.y : to.y + to.height };
    const candidates = [[a, b]];
    const xs = [230, 28, model.width - 12, ...model.nodes.flatMap((node) => [node.x - 10, node.x + node.width + 10])].filter(
      (x) => x > 8 && x < model.width - 8
    );
    const ys = [
      (a.y + b.y) / 2,
      ...model.layers.flatMap((layer) => [layer.y - 8, layer.y + layer.height + 24]),
      ...model.nodes.flatMap((node) => [node.y - 8, node.y + node.height + 8])
    ].filter((y) => y > 104 && y < model.height - 8);
    for (const y of [...new Set(ys)].slice(0, 130)) candidates.push([a, { x: a.x, y }, { x: b.x, y }, b]);
    for (const x of [...new Set(xs)].slice(0, 130)) {
      if (sameRow) candidates.push([a, { x, y: a.y }, { x, y: b.y }, b]);
      else {
        const sign = down ? 1 : -1;
        const first = a.y + sign * 4,
          last = b.y - sign * 4;
        candidates.push([a, { x: a.x, y: first }, { x, y: first }, { x, y: last }, { x: b.x, y: last }, b]);
      }
    }
    const label = edge.label || (edge.type === 'workflow' && edge.meaning?.length <= 12 ? edge.meaning : null);
    let best, bestLabel,
      score = Infinity;
    for (const raw of candidates.slice(0, 300)) {
      const points = simplify(raw);
      if (points.length < 2 || points.some((p, i) => i && p.x !== points[i - 1].x && p.y !== points[i - 1].y)) continue;
      if (!sameRow && edge.type !== 'feedback' && points.some((point, index) => index && (point.y - points[index - 1].y) * (down ? 1 : -1) < 0)) continue;
      if (
        points.some(
          (point, index) =>
            index && boxes.some((box) => box.obstacleId !== edge.from && box.obstacleId !== edge.to && segmentHits(points[index - 1], point, box))
        )
      )
        continue;
      if (points.some((point,index)=>index && labels.some(box=>routeHitsBox(points[index-1],point,box)))) continue;
      const candidateLabel = label ? routeLabelPosition(points,label,{boxes,labels,routes:used,width:model.width}) : null;
      if (label && !candidateLabel) continue;
      let cost = (points.length - 2) * 32;
      for (let index = 1; index < points.length; index++) {
        const first = points[index - 1],
          last = points[index];
        cost += Math.abs(last.x - first.x) + Math.abs(last.y - first.y);
        for (const previous of used) for (let j = 1; j < previous.length; j++) {
          const a=previous[j-1],b=previous[j];
          if (crossing(first,last,a,b)) cost += 180;
          // 共线重叠比相交更难辨别，尤其正向工单与反向反馈；不让反向箭头叠在同一段。
          const overlap = first.y===last.y && a.y===b.y && first.y===a.y
            ? Math.min(Math.max(first.x,last.x),Math.max(a.x,b.x))-Math.max(Math.min(first.x,last.x),Math.min(a.x,b.x))
            : first.x===last.x && a.x===b.x && first.x===a.x
              ? Math.min(Math.max(first.y,last.y),Math.max(a.y,b.y))-Math.max(Math.min(first.y,last.y),Math.min(a.y,b.y)) : 0;
          if (overlap>2) cost += 10000+overlap*20;
        }
      }
      if (cost < score) {
        best = points;
        bestLabel = candidateLabel;
        score = cost;
      }
    }
    if (!best) throw invalid('关系无法避开对象和标题：' + from.title + ' → ' + to.title + '；请重排模块或拆为总体/流程/数据流视图，未删除关系');
    used.push(best);
    const labelPosition = bestLabel;
    if (labelPosition) labels.push(labelBox(labelPosition));
    result.set(edge.index, {
      ...edge,
      points: best,
      ...(labelPosition ? { label, labelPosition } : { label: undefined }),
      path: best.map((p, index) => `${index ? 'L' : 'M'}${p.x},${p.y}`).join(' ')
    });
  }
  return model.edges.map((_, index) => result.get(index));
}
