/**
 * 流程图 / 泳道图 / 思维导图（2026-11-17 用户：检查业务图、流程图的制作流程和工具是否对）。
 *
 * 以前只有画“分层方块”架构图的 create_diagram，流程图会被画成分层架构图：没有判断分支、没有泳道、看不出流转。
 * 这里是独立的流程图引擎：模型只给节点、连线、泳道，坐标全部由程序算：
 *   1. 分层：从开始节点按连线往下排“第几步”，回头的连线（循环、退回）不参与分层；
 *   2. 排序：同一步里的节点按上下游位置取平均反复调整，减少交叉；
 *   3. 泳道：有泳道时每条泳道一列（横排时一行），节点只在自己的泳道里；
 *   4. 连线：直角折线，回头的线从侧面绕开；判断分支的“是/否”写在线上；
 *   5. 输出：同一份布局导出 SVG（再渲染成 PNG）和原生可编辑 PPTX（形状、文字、线条都能改）。
 * 程序会数连线交叉、检查判断节点是否至少两条出口，如实写进回执，不冒充“版式完美”。
 */
import { wrapParagraphs } from './posterComposition.js';
import { DESIGN_FONT, escapeDesignXml as esc } from './layeredDesignSvg.js';
import { validateVisualSceneSvg } from './visualSceneSvg.js';

export const FLOW_TYPES = ['start', 'end', 'process', 'decision', 'io', 'document', 'subprocess', 'data'];
export const FLOW_LIMITS = { nodes: 60, edges: 120, lanes: 8, text: 40, label: 12 };
const flowError = (message, code = 'FLOWCHART_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });
const THEMES = {
  blue: { background: '#FFFFFF', ink: '#1F2A37', line: '#5B6B7F', accent: '#2563EB', fill: '#EEF4FF', start: '#DCFCE7', end: '#FEE2E2', decision: '#FEF3C7', lane: '#F6F8FB', laneHead: '#E6ECF5', border: '#9DB2D3' },
  gray: { background: '#FFFFFF', ink: '#222222', line: '#666666', accent: '#333333', fill: '#F3F4F6', start: '#E5E7EB', end: '#E5E7EB', decision: '#F9FAFB', lane: '#FAFAFA', laneHead: '#EEEEEE', border: '#A3A3A3' },
  green: { background: '#FFFFFF', ink: '#1C2B22', line: '#5C7065', accent: '#15803D', fill: '#ECFDF3', start: '#D1FAE5', end: '#FEE2E2', decision: '#FEF9C3', lane: '#F5FAF7', laneHead: '#E3F1E8', border: '#9CC3AB' }
};
const round = n => Math.round(n * 10) / 10;
const text = (value, max, what) => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw flowError(`${what}不能为空`);
  if ([...v].length > max) throw flowError(`${what}“${v.slice(0, 12)}…”超过${max}字，请精简（不自动截字）`);
  return v;
};
const idOf = (value, what) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) throw flowError(`${what}的id需为1–40位字母、数字、下划线或短横线`);
  return value;
};

/** 校验并整理输入；不合规直接报错说明，不静默丢节点、丢连线 */
export function normalizeFlowchart(raw) {
  if (!raw || typeof raw !== 'object') throw flowError('请提供流程图参数');
  const kind = ['flow', 'swimlane', 'mindmap'].includes(raw.kind) ? raw.kind : Array.isArray(raw.lanes) && raw.lanes.length ? 'swimlane' : 'flow';
  const direction = raw.direction === 'LR' || kind === 'mindmap' && raw.direction !== 'TB' ? 'LR' : 'TB';
  const lanes = (Array.isArray(raw.lanes) ? raw.lanes : []).map((lane, i) => ({ id: idOf(lane?.id, `第${i + 1}条泳道`), title: text(lane?.title, 16, '泳道标题') }));
  if (lanes.length > FLOW_LIMITS.lanes) throw flowError(`泳道最多${FLOW_LIMITS.lanes}条`);
  if (kind === 'swimlane' && lanes.length < 2) throw flowError('泳道图至少需要2条泳道（lanes）');
  if (!Array.isArray(raw.nodes) || raw.nodes.length < 2 || raw.nodes.length > FLOW_LIMITS.nodes) throw flowError(`流程图需要2–${FLOW_LIMITS.nodes}个节点；更多请拆成总览图和分图`);
  const nodes = raw.nodes.map((node, i) => {
    const type = FLOW_TYPES.includes(node?.type) ? node.type : kind === 'mindmap' ? 'process' : 'process';
    const out = { id: idOf(node?.id, `第${i + 1}个节点`), text: text(node?.text, FLOW_LIMITS.text, '节点文字'), type };
    if (lanes.length) {
      if (!lanes.some(lane => lane.id === node.lane)) throw flowError(`节点${out.id}要写所属泳道lane（${lanes.map(l => l.id).join('/')}）`);
      out.lane = node.lane;
    }
    return out;
  });
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw flowError('节点id不能重复');
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (!Array.isArray(raw.edges) || !raw.edges.length || raw.edges.length > FLOW_LIMITS.edges) throw flowError(`需要1–${FLOW_LIMITS.edges}条连线（edges）`);
  const edges = raw.edges.map((edge, i) => {
    if (!byId.has(edge?.from) || !byId.has(edge?.to)) throw flowError(`第${i + 1}条连线的from/to必须是已有节点id`);
    if (edge.from === edge.to) throw flowError(`第${i + 1}条连线首尾是同一节点`);
    return { from: edge.from, to: edge.to, ...(edge.label !== undefined && edge.label !== '' && { label: text(edge.label, FLOW_LIMITS.label, '连线文字') }) };
  });
  const linked = new Set(edges.flatMap(e => [e.from, e.to]));
  const orphan = nodes.filter(n => !linked.has(n.id));
  if (orphan.length) throw flowError(`节点${orphan.map(n => n.id).join('、')}没有任何连线；流程图里每个节点都要接上`);
  return { kind: 'flowchart', version: 1, title: text(raw.title, 40, '标题'), flowKind: kind, direction, theme: THEMES[raw.theme] ? raw.theme : 'blue', lanes, nodes, edges };
}

/** 节点尺寸：按真实字宽换行，判断菱形要更大才能放下字 */
function measure(node, font) {
  const maxW = node.type === 'decision' ? 150 : 180;
  const rows = wrapParagraphs(node.text, font, maxW) || [node.text];
  const textW = Math.max(...rows.map(r => [...r].length * font * 0.95));
  const textH = rows.length * font * 1.4;
  if (node.type === 'decision') return { rows, w: Math.max(150, textW * 1.7 + 20), h: Math.max(84, textH * 1.9 + 16) };
  return { rows, w: Math.max(node.type === 'start' || node.type === 'end' ? 120 : 140, textW + 40), h: Math.max(52, textH + 24) };
}

/** 分层：沿连线走，回头的线（指向祖先）不参与；无入边的节点从第0层开始 */
function ranks(flow) {
  const out = new Map(flow.nodes.map(n => [n.id, []])), back = new Set();
  flow.edges.forEach((e, i) => out.get(e.from).push({ to: e.to, i }));
  const state = new Map(), order = [];
  const visit = id => {
    state.set(id, 1);
    for (const { to, i } of out.get(id)) {
      if (state.get(to) === 1) back.add(i);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2); order.push(id);
  };
  const incoming = new Set(flow.edges.map(e => e.to));
  const roots = flow.nodes.filter(n => n.type === 'start' || !incoming.has(n.id));
  for (const n of [...roots, ...flow.nodes]) if (!state.has(n.id)) visit(n.id);
  const rank = new Map(flow.nodes.map(n => [n.id, 0]));
  for (const id of order.reverse()) for (const { to, i } of out.get(id)) if (!back.has(i)) rank.set(to, Math.max(rank.get(to), rank.get(id) + 1));
  return { rank, back };
}

export function layoutFlowchart(flow) {
  const font = 15, gapMain = 64, gapCross = 40, laneHead = 40, margin = 32, titleH = 64;
  const LR = flow.direction === 'LR';
  const size = new Map(flow.nodes.map(n => [n.id, measure(n, font)]));
  const { rank, back } = ranks(flow);
  const maxRank = Math.max(...rank.values());
  // 每个“步骤”里的节点，按泳道分组；用上下游平均位置排序，来回各3遍
  const lanesOf = flow.lanes.length ? flow.lanes.map(l => l.id) : ['_'];
  const laneOf = n => n.lane || '_';
  const groups = new Map();
  for (const n of flow.nodes) {
    const key = laneOf(n) + '|' + rank.get(n.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n.id);
  }
  const pos = new Map();
  const indexIn = () => { for (const ids of groups.values()) ids.forEach((id, i) => pos.set(id, i)); };
  indexIn();
  const neighbours = (id, up) => flow.edges.filter((e, i) => !back.has(i) && (up ? e.to === id : e.from === id)).map(e => (up ? e.from : e.to));
  for (let pass = 0; pass < 6; pass++) {
    const up = pass % 2 === 0;
    for (const ids of groups.values()) {
      const score = id => { const list = neighbours(id, up).map(n => pos.get(n)); return list.length ? list.reduce((s, v) => s + v, 0) / list.length : pos.get(id); };
      ids.sort((a, b) => score(a) - score(b));
    }
    indexIn();
  }
  // 交叉方向尺寸：每条泳道宽度取各步里最宽的那组；主方向尺寸：每一步取最高的节点
  const crossOf = id => (LR ? size.get(id).h : size.get(id).w), mainOf = id => (LR ? size.get(id).w : size.get(id).h);
  const laneSpan = new Map(lanesOf.map(lane => [lane, 0]));
  for (const [key, ids] of groups) {
    const lane = key.split('|')[0];
    laneSpan.set(lane, Math.max(laneSpan.get(lane), ids.reduce((s, id) => s + crossOf(id), 0) + gapCross * (ids.length - 1)));
  }
  const stepSpan = Array.from({ length: maxRank + 1 }, (_, r) => Math.max(...flow.nodes.filter(n => rank.get(n.id) === r).map(n => mainOf(n.id))));
  const lanePad = flow.lanes.length ? 28 : 0;
  const head = flow.lanes.length ? laneHead : 0;
  // 横排时标题在上方，泳道（行）从标题下面开始；竖排时标题占主方向开头
  let crossCursor = LR ? margin + titleH : margin;
  const laneBox = new Map();
  for (const lane of lanesOf) {
    const span = laneSpan.get(lane) + lanePad * 2;
    laneBox.set(lane, { start: crossCursor, span });
    crossCursor += span;
  }
  const stepStart = [];
  let mainCursor = LR ? margin + head + 24 : margin + titleH + head + 24;
  stepSpan.forEach((span, r) => { stepStart[r] = mainCursor; mainCursor += span + gapMain; });
  const mainTotal = mainCursor - gapMain + 32;
  const boxes = new Map();
  for (const [key, ids] of groups) {
    const [lane, r] = [key.split('|')[0], Number(key.split('|')[1])];
    const lb = laneBox.get(lane), used = ids.reduce((s, id) => s + crossOf(id), 0) + gapCross * (ids.length - 1);
    let c = lb.start + (lb.span - used) / 2;
    for (const id of ids) {
      const { w, h } = size.get(id), main = stepStart[r] + (stepSpan[r] - mainOf(id)) / 2;
      boxes.set(id, LR ? { x: main, y: c, w, h } : { x: c, y: main, w, h });
      c += crossOf(id) + gapCross;
    }
  }
  // 回头线从侧面绕：在最外侧留出绕线通道
  const detour = back.size ? 48 : 0;
  const width = Math.ceil(LR ? mainTotal + margin : crossCursor + margin + detour);
  const height = Math.ceil(LR ? crossCursor + margin + detour : mainTotal + margin);
  const edges = flow.edges.map((e, i) => route(boxes.get(e.from), boxes.get(e.to), { LR, back: back.has(i), outer: LR ? height - margin / 2 - detour / 2 : width - margin / 2 - detour / 2, edge: e, boxes, gap: gapMain }));
  const laneRects = flow.lanes.map(l => {
    const lb = laneBox.get(l.id), mainFrom = margin + titleH, mainTo = height - margin / 2;
    return { ...l, ...(LR ? { x: margin / 2, y: lb.start, w: width - margin, h: lb.span } : { x: lb.start, y: mainFrom, w: lb.span, h: mainTo - mainFrom }) };
  });
  return { width, height, boxes, sizes: size, edges, lanes: laneRects, LR, titleH, margin, font, back };
}

/** 竖直或水平线段是否穿过某个节点框（留4像素余量；起止两个节点除外） */
function blocked(p, q, boxes, skip) {
  const [x1, x2] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])], [y1, y2] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
  return boxes.some(b => !skip.includes(b) && x2 > b.x - 4 && x1 < b.x + b.w + 4 && y2 > b.y - 4 && y1 < b.y + b.h + 4);
}
const pathBlocked = (pts, boxes, skip) => pts.slice(1).some((q, k) => blocked(pts[k], q, boxes, skip));

/**
 * 直角折线：顺向连线在“靠近目标的空隙”或“紧贴源节点的空隙”拐弯，选不穿过其它节点的那条；
 * 回头的线（退回、循环）从外侧通道绕回。
 */
function route(a, b, { LR, back, outer, edge, boxes, gap }) {
  let pts;
  const all = [...boxes.values()], skip = [a, b];
  if (!back) {
    if (LR) {
      const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2;
      const options = Math.abs(sy - ty) < 1 ? [[[sx, sy], [tx, ty]]] : [tx - gap / 2, sx + gap / 2, (sx + tx) / 2].map(m => [[sx, sy], [m, sy], [m, ty], [tx, ty]]);
      pts = options.find(o => !pathBlocked(o, all, skip)) || options[0];
    } else {
      const sx = a.x + a.w / 2, sy = a.y + a.h, tx = b.x + b.w / 2, ty = b.y;
      const options = Math.abs(sx - tx) < 1 ? [[[sx, sy], [tx, ty]]] : [ty - gap / 2, sy + gap / 2, (sy + ty) / 2].map(m => [[sx, sy], [sx, m], [tx, m], [tx, ty]]);
      pts = options.find(o => !pathBlocked(o, all, skip)) || options[0];
    }
  } else if (LR) {
    const sx = a.x + a.w / 2, sy = a.y + a.h, tx = b.x + b.w / 2, ty = b.y + b.h;
    pts = [[sx, sy], [sx, outer], [tx, outer], [tx, ty]];
  } else {
    const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x + b.w, ty = b.y + b.h / 2;
    pts = [[sx, sy], [outer, sy], [outer, ty], [tx, ty]];
  }
  return { ...edge, back, points: pts.map(([x, y]) => [round(x), round(y)]) };
}

/** 连线交叉数（只算不同连线的线段相交，共享端点不算） */
export function countCrossings(edges) {
  const segs = edges.flatMap((e, i) => e.points.slice(1).map((p, k) => ({ i, a: e.points[k], b: p })));
  const cross = (s, t) => {
    const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const share = [s.a, s.b].some(p => [t.a, t.b].some(q => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5));
    if (share) return false;
    return d(s.a, s.b, t.a) * d(s.a, s.b, t.b) < 0 && d(t.a, t.b, s.a) * d(t.a, t.b, s.b) < 0;
  };
  let n = 0;
  for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) if (segs[x].i !== segs[y].i && cross(segs[x], segs[y])) n++;
  return n;
}

function shapeSvg(node, box, theme) {
  const { x, y, w, h } = box, stroke = `stroke="${theme.border}" stroke-width="1.5"`;
  const fill = node.type === 'start' ? theme.start : node.type === 'end' ? theme.end : node.type === 'decision' ? theme.decision : theme.fill;
  if (node.type === 'start' || node.type === 'end') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" ${stroke}/>`;
  if (node.type === 'decision') return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${fill}" ${stroke}/>`;
  if (node.type === 'io' || node.type === 'data') { const k = 16; return `<polygon points="${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}" fill="${fill}" ${stroke}/>`; }
  if (node.type === 'document') return `<path d="M${x} ${y}H${x + w}V${y + h - 10}C${x + w * 0.75} ${y + h - 22} ${x + w * 0.25} ${y + h + 4} ${x} ${y + h - 8}Z" fill="${fill}" ${stroke}/>`;
  if (node.type === 'subprocess') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" ${stroke}/><line x1="${x + 10}" y1="${y}" x2="${x + 10}" y2="${y + h}" ${stroke}/><line x1="${x + w - 10}" y1="${y}" x2="${x + w - 10}" y2="${y + h}" ${stroke}/>`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" ${stroke}/>`;
}
/** 横排泳道的标题竖着写，一字一行，不截字 */
function verticalTitle(lane, theme) {
  const chars = [...lane.title], step = Math.min(18, (lane.h - 16) / chars.length), top = lane.y + (lane.h - step * chars.length) / 2;
  return chars.map((ch, i) => `<text x="${lane.x + 20}" y="${round(top + step * (i + 0.8))}" font-family="${DESIGN_FONT}" font-size="${Math.min(15, step)}" font-weight="700" fill="${theme.ink}" text-anchor="middle">${esc(ch)}</text>`).join('');
}
function arrowHead([px, py], [x, y], color) {
  const len = 10, half = 5, dx = x - px, dy = y - py, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const bx = x - ux * len, by = y - uy * len;
  return `<polygon points="${round(x)},${round(y)} ${round(bx - uy * half)},${round(by + ux * half)} ${round(bx + uy * half)},${round(by - ux * half)}" fill="${color}"/>`;
}
/** 连线文字放在第一段折线的中点旁，避开节点 */
export function labelPosition(edge) {
  const [a, b] = edge.points.length > 2 ? [edge.points[1], edge.points[2]] : [edge.points[0], edge.points[1]];
  return { x: round((a[0] + b[0]) / 2), y: round((a[1] + b[1]) / 2) };
}

export function flowchartScale(layout) {
  const longest = Math.max(layout.width, layout.height);
  if (longest > 4096) throw flowError('流程图太大（最长边超过4096像素），请拆成总览图和几张分图');
  return Math.max(1, Math.min(2, Math.floor((4096 / longest) * 100) / 100));
}
export function composeFlowchartSvg(flow, layout = layoutFlowchart(flow)) {
  const theme = THEMES[flow.theme], { width, height, font } = layout, parts = [];
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.background}"/>`);
  parts.push(`<text x="${layout.margin}" y="${layout.margin + 28}" font-family="${DESIGN_FONT}" font-size="26" font-weight="700" fill="${theme.ink}">${esc(flow.title)}</text>`);
  for (const lane of layout.lanes) {
    parts.push(`<g id="lane-${lane.id}"><rect x="${lane.x}" y="${lane.y}" width="${lane.w}" height="${lane.h}" fill="${theme.lane}" stroke="${theme.border}" stroke-width="1"/>`);
    parts.push(layout.LR
      ? `<rect x="${lane.x}" y="${lane.y}" width="40" height="${lane.h}" fill="${theme.laneHead}"/>${verticalTitle(lane, theme)}</g>`
      : `<rect x="${lane.x}" y="${lane.y}" width="${lane.w}" height="40" fill="${theme.laneHead}"/><text x="${lane.x + lane.w / 2}" y="${lane.y + 26}" font-family="${DESIGN_FONT}" font-size="15" font-weight="700" fill="${theme.ink}" text-anchor="middle">${esc(lane.title)}</text></g>`);
  }
  layout.edges.forEach((edge, i) => {
    const pts = edge.points;
    parts.push(`<g id="edge-${i}"><polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${theme.line}" stroke-width="1.6"${edge.back ? ' stroke-dasharray="6 4"' : ''}/>${arrowHead(pts.at(-2), pts.at(-1), theme.line)}`);
    if (edge.label) {
      const p = labelPosition(edge), w = [...edge.label].length * 13 + 10;
      parts.push(`<rect x="${round(p.x - w / 2)}" y="${round(p.y - 11)}" width="${w}" height="22" rx="4" fill="${theme.background}"/><text x="${p.x}" y="${round(p.y + 5)}" font-family="${DESIGN_FONT}" font-size="13" fill="${theme.accent}" text-anchor="middle">${esc(edge.label)}</text>`);
    }
    parts.push('</g>');
  });
  for (const node of flow.nodes) {
    const box = layout.boxes.get(node.id), { rows } = layout.sizes.get(node.id), lineH = font * 1.4, top = box.y + (box.h - rows.length * lineH) / 2;
    parts.push(`<g id="node-${node.id}">${shapeSvg(node, box, theme)}${rows.map((row, i) => `<text x="${round(box.x + box.w / 2)}" y="${round(top + font * 1.05 + i * lineH)}" font-family="${DESIGN_FONT}" font-size="${font}" fill="${theme.ink}" text-anchor="middle" xml:space="preserve">${esc(row)}</text>`).join('')}</g>`);
  }
  // 导出按2倍像素渲染（最长边不超过4096），手机放大看也清楚；坐标仍按原尺寸
  const scale = flowchartScale(layout), W = Math.round(width * scale), H = Math.round(height * scale);
  return validateVisualSceneSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g transform="scale(${scale})">${parts.join('')}</g></svg>`).svg;
}

/** 原生可编辑 PPTX：节点是 PowerPoint 自带的流程图形状，连线是带箭头的线段 */
export async function composeFlowchartPptx(flow, layout = layoutFlowchart(flow)) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS(), inch = px => px / 96, theme = THEMES[flow.theme], c = v => v.slice(1);
  pptx.defineLayout({ name: 'FLOW', width: inch(layout.width), height: inch(layout.height) });
  pptx.layout = 'FLOW'; pptx.title = flow.title; pptx.author = '未央'; pptx.lang = 'zh-CN';
  const slide = pptx.addSlide();
  slide.background = { color: c(theme.background) };
  const font = 'Noto Sans CJK SC';
  slide.addText(flow.title, { x: inch(layout.margin), y: inch(layout.margin), w: inch(layout.width - layout.margin * 2), h: inch(40), fontSize: 20, bold: true, fontFace: font, color: c(theme.ink), margin: 0 });
  for (const lane of layout.lanes) {
    slide.addShape(pptx.ShapeType.rect, { x: inch(lane.x), y: inch(lane.y), w: inch(lane.w), h: inch(lane.h), fill: { color: c(theme.lane) }, line: { color: c(theme.border), width: 0.75 }, objectName: `lane-${lane.id}` });
    slide.addText(lane.title, { x: inch(lane.x), y: inch(lane.y), w: inch(layout.LR ? 40 : lane.w), h: inch(layout.LR ? lane.h : 40), fontSize: 11, bold: true, fontFace: font, color: c(theme.ink), align: 'center', valign: 'middle', fill: { color: c(theme.laneHead) }, margin: 0 });
  }
  const shapeOf = type => ({ start: pptx.ShapeType.flowChartTerminator, end: pptx.ShapeType.flowChartTerminator, decision: pptx.ShapeType.flowChartDecision, io: pptx.ShapeType.flowChartInputOutput, data: pptx.ShapeType.flowChartInputOutput, document: pptx.ShapeType.flowChartDocument, subprocess: pptx.ShapeType.flowChartPredefinedProcess })[type] || pptx.ShapeType.flowChartProcess;
  layout.edges.forEach((edge, i) => {
    edge.points.slice(1).forEach((p, k) => {
      const a = edge.points[k], last = k === edge.points.length - 2;
      slide.addShape(pptx.ShapeType.line, { x: inch(Math.min(a[0], p[0])), y: inch(Math.min(a[1], p[1])), w: inch(Math.abs(p[0] - a[0])), h: inch(Math.abs(p[1] - a[1])),
        flipH: p[0] < a[0], flipV: p[1] < a[1], line: { color: c(theme.line), width: 1.2, ...(edge.back && { dashType: 'dash' }), ...(last && { endArrowType: 'triangle' }) }, objectName: `edge-${i}-${k}` });
    });
    if (edge.label) {
      const p = labelPosition(edge), w = [...edge.label].length * 13 + 10;
      slide.addText(edge.label, { x: inch(p.x - w / 2), y: inch(p.y - 11), w: inch(w), h: inch(22), fontSize: 10, fontFace: font, color: c(theme.accent), align: 'center', valign: 'middle', fill: { color: c(theme.background) }, margin: 0, objectName: `edge-${i}-label` });
    }
  });
  for (const node of flow.nodes) {
    const box = layout.boxes.get(node.id);
    const fill = node.type === 'start' ? theme.start : node.type === 'end' ? theme.end : node.type === 'decision' ? theme.decision : theme.fill;
    slide.addText(node.text, { shape: shapeOf(node.type), x: inch(box.x), y: inch(box.y), w: inch(box.w), h: inch(box.h), fill: { color: c(fill) }, line: { color: c(theme.border), width: 1 },
      fontSize: 11, fontFace: font, color: c(theme.ink), align: 'center', valign: 'middle', margin: 2, objectName: `node-${node.id}` });
  }
  return pptx.write({ outputType: 'blob' });
}

/** 结构体检：判断节点要有至少两个出口且出口写明条件；结束节点不应再有出边 */
export function checkFlowchart(flow, layout) {
  const issues = [];
  for (const node of flow.nodes.filter(n => n.type === 'decision')) {
    const outs = flow.edges.filter(e => e.from === node.id);
    if (outs.length < 2) issues.push({ code: 'FLOW_DECISION_BRANCHES', id: node.id, message: `判断“${node.text}”只有${outs.length}个出口，判断至少要有两个分支（如是/否）` });
    else if (outs.some(e => !e.label)) issues.push({ code: 'FLOW_DECISION_LABEL', id: node.id, message: `判断“${node.text}”的出口要写条件（如“是/否”“通过/退回”）` });
  }
  for (const node of flow.nodes.filter(n => n.type === 'end')) if (flow.edges.some(e => e.from === node.id)) issues.push({ code: 'FLOW_END_HAS_OUTPUT', id: node.id, message: `结束节点“${node.text}”不应再有出去的连线` });
  if (flow.flowKind !== 'mindmap' && !flow.nodes.some(n => n.type === 'start')) issues.push({ code: 'FLOW_NO_START', message: '流程图建议用type=start标出起点' });
  return { status: issues.length ? 'needs_review' : 'passed', issues, crossings: countCrossings(layout.edges), backEdges: layout.back.size };
}
