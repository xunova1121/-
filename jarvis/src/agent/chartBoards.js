/**
 * 时间类与表格类图示：甘特图、时间轴、看板、权限/对照矩阵、用户旅程、服务蓝图、故事地图、分层堆叠、嵌套范围。
 * 坐标全部由程序算；文字按真实字宽换行，放不下就报错，不截字。
 */
import { sceneError, textItem, titleBlock, textWidth } from './chartScene.js';

const list = (v, what, min, max) => { if (!Array.isArray(v) || v.length < min || v.length > max) throw sceneError(`${what}需要${min}–${max}项`); return v; };
const label = (v, what, max = 30) => { const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''; if (!s) throw sceneError(`${what}不能为空`); if ([...s].length > max) throw sceneError(`${what}“${s.slice(0, 10)}…”超过${max}字，请精简`); return s; };
const optional = (v, what, max) => (v === undefined || v === null || v === '' ? '' : label(v, what, max));
const DAY = 86400000;
function date(v, what) {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(v || '').trim());
  if (!m) throw sceneError(`${what}要写成2026-03-15或2026-03这样的日期`);
  const d = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
  if (Number.isNaN(d)) throw sceneError(`${what}不是有效日期`);
  return d;
}
const md = t => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

export function ganttChart(data, theme) {
  const tasks = list(data.tasks, '任务tasks', 1, 40).map((t, i) => {
    const start = date(t?.start, `第${i + 1}个任务的开始`), end = t?.milestone ? start : date(t?.end, `第${i + 1}个任务的结束`);
    if (end < start) throw sceneError(`任务“${t.label}”结束早于开始`);
    const progress = t?.progress === undefined ? null : Number(t.progress);
    if (progress !== null && !(progress >= 0 && progress <= 1)) throw sceneError('进度progress需在0到1之间');
    return { label: label(t?.label, `第${i + 1}个任务名`, 20), group: optional(t?.group, '分组', 12), start, end: end + (t?.milestone ? 0 : DAY), milestone: t?.milestone === true, progress, focus: t?.focus === true };
  });
  const lo = Math.min(...tasks.map(t => t.start)), hi = Math.max(...tasks.map(t => t.end)), days = Math.max(1, (hi - lo) / DAY);
  const labelW = Math.min(260, Math.max(120, ...tasks.map(t => textWidth(t.label, 13) + (t.group ? 0 : 0)))) + 24, width = Math.max(900, labelW + Math.min(1400, days * 6) + 60);
  const items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 }), x = 40 + labelW, w = width - x - 40, row = 32;
  const X = t => x + (t - lo) / (hi - lo || DAY) * w;
  const rowCount = tasks.length + new Set(tasks.map(t => t.group).filter(Boolean)).size;
  // 刻度：跨度大按月，小按周
  const ticks = [];
  if (days > 75) { const d = new Date(lo); for (let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); t <= hi; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) if (t >= lo) ticks.push([t, `${new Date(t).getUTCFullYear() % 100}年${new Date(t).getUTCMonth() + 1}月`]); }
  else for (let t = lo; t <= hi; t += 7 * DAY) ticks.push([t, md(t)]);
  for (const [t, name] of ticks) { items.push({ t: 'line', x1: X(t), y1: top + 22, x2: X(t), y2: top + 30 + rowCount * row, stroke: theme.rule }); items.push(textItem(name, X(t) + 4, top, { size: 12, color: theme.muted })); }
  // 分组单独占一行标题，不压在任务名上
  let group = null, line = 0;
  const rowOf = [];
  tasks.forEach(t => { if (t.group && t.group !== group) { group = t.group; rowOf.push({ header: t.group, line: line++ }); } rowOf.push({ task: t, line: line++ }); });
  for (const r of rowOf.filter(r => r.header)) items.push(textItem(r.header, 44, top + 30 + r.line * row + 9, { size: 12, color: theme.accent, weight: 700 }));
  rowOf.filter(r => r.task).forEach(({ task: t, line: li }, i) => {
    const y = top + 30 + li * row;
    if (i % 2 === 0) items.push({ t: 'rect', x: 40, y, w: width - 80, h: row, fill: theme.panel });
    items.push(textItem(t.label, t.group ? 60 : 48, y + 7, { size: 13, color: theme.ink, weight: t.focus ? 700 : 400 }));
    if (t.milestone) { const cx = X(t.start); items.push({ t: 'polygon', points: [[cx, y + 6], [cx + 10, y + 16], [cx, y + 26], [cx - 10, y + 16]], fill: theme.accent }); const right = cx + 60 < width - 40; items.push(textItem(md(t.start), right ? cx + 14 : cx - 14, y + 8, { size: 11, color: theme.muted, anchor: right ? 'start' : 'end' })); return; }
    const bx = X(t.start), bw = Math.max(4, X(t.end) - bx);
    items.push({ t: 'rect', x: bx, y: y + 7, w: bw, h: row - 14, r: 3, fill: t.focus ? theme.accent : theme.accentTint, stroke: theme.accent, sw: 1 });
    if (t.progress !== null) items.push({ t: 'rect', x: bx, y: y + 7, w: bw * t.progress, h: row - 14, r: 3, fill: theme.accent, opacity: 0.75 });
    const tag = `${md(t.start)}–${md(t.end - DAY)}${t.progress !== null ? ` · ${Math.round(t.progress * 100)}%` : ''}`;
    items.push(textItem(tag, bx + bw + 6 + textWidth(tag, 11) > width - 40 ? bx - 6 : bx + bw + 6, y + 9, { size: 11, color: theme.muted, anchor: bx + bw + 6 + textWidth(tag, 11) > width - 40 ? 'end' : 'start' }));
  });
  if (data.today) { const t = date(data.today, '今天today'); if (t >= lo && t <= hi) { items.push({ t: 'line', x1: X(t), y1: top + 22, x2: X(t), y2: top + 30 + rowCount * row, stroke: theme.bad, sw: 1.5, dash: '4 3' }); items.push(textItem('今天', X(t), top + 30 + rowCount * row + 4, { size: 11, color: theme.bad, anchor: 'middle' })); } }
  return { width, height: top + 30 + rowCount * row + 36, items };
}

export function timelineChart(data, theme) {
  const events = list(data.events, '事件events', 2, 16).map((e, i) => ({ when: label(e?.date, `第${i + 1}个时间`, 16), label: label(e?.label, `第${i + 1}个事件`, 20), note: optional(e?.note, '说明', 50), focus: e?.focus === true }));
  const gap = 170, width = Math.max(860, 120 + (events.length - 1) * gap + 120), items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const axisY = top + 170, x0 = 100;
  items.push({ t: 'line', x1: 60, y1: axisY, x2: width - 50, y2: axisY, stroke: theme.soft, sw: 2, arrow: 'end' });
  events.forEach((e, i) => {
    const x = x0 + i * gap, up = i % 2 === 0;
    items.push({ t: 'ellipse', cx: x, cy: axisY, rx: e.focus ? 9 : 6, ry: e.focus ? 9 : 6, fill: e.focus ? theme.accent : theme.background, stroke: theme.accent, sw: 2 });
    items.push({ t: 'line', x1: x, y1: up ? axisY - 12 : axisY + 12, x2: x, y2: up ? axisY - 40 : axisY + 40, stroke: theme.rule, sw: 1 });
    const block = [textItem(e.when, x - gap / 2 + 6, 0, { size: 12, color: theme.accent, weight: 700, w: gap - 12, anchor: 'middle' }), textItem(e.label, x - gap / 2 + 6, 0, { size: 14, color: theme.ink, weight: 700, w: gap - 12, anchor: 'middle', maxRows: 2 }),
      ...(e.note ? [textItem(e.note, x - gap / 2 + 6, 0, { size: 12, color: theme.muted, w: gap - 12, anchor: 'middle', maxRows: 3 })] : [])];
    const total = block.reduce((s, b) => s + b.h + 2, 0);
    let y = up ? axisY - 44 - total : axisY + 44;
    for (const b of block) { b.y = y; y += b.h + 2; items.push(b); }
  });
  return { width, height: axisY + 160, items };
}

export function kanbanChart(data, theme) {
  const cols = list(data.columns, '列columns', 2, 7).map((c, i) => ({ title: label(c?.title, `第${i + 1}列`, 12), limit: c?.limit === undefined ? null : Number(c.limit),
    cards: list(c?.cards || [], `第${i + 1}列的cards`, 0, 12).map((k, j) => ({ text: label(k?.text, `第${i + 1}列第${j + 1}张卡`, 40), tag: optional(k?.tag, '标签', 8), blocked: k?.blocked === true })) }));
  const colW = 210, width = 40 + cols.length * (colW + 14) + 26, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  let bottom = top;
  cols.forEach((c, i) => {
    const x = 40 + i * (colW + 14), over = c.limit !== null && c.cards.length > c.limit;
    let y = top + 40;
    const cards = c.cards.map(k => { const t = textItem(k.text, x + 22, 0, { size: 13, color: theme.ink, w: colW - 34, maxRows: 4 }); return { k, t, h: t.h + (k.tag ? 24 : 0) + 18 }; });
    const colH = 48 + cards.reduce((s, c2) => s + c2.h + 8, 0) + 8;
    items.push({ t: 'rect', x, y: top, w: colW, h: Math.max(colH, 120), r: 6, fill: theme.panel, stroke: over ? theme.bad : theme.rule, sw: over ? 2 : 1 });
    items.push(textItem(`${c.title}${c.limit !== null ? `（${c.cards.length}/${c.limit}）` : `（${c.cards.length}）`}`, x + 12, top + 12, { size: 14, weight: 700, color: over ? theme.bad : theme.ink }));
    for (const { k, t, h } of cards) {
      items.push({ t: 'rect', x: x + 10, y, w: colW - 20, h, r: 4, fill: theme.background, stroke: k.blocked ? theme.bad : theme.rule, sw: k.blocked ? 2 : 1 });
      if (k.blocked) items.push({ t: 'rect', x: x + 10, y, w: 4, h, fill: theme.bad });
      t.y = y + 9; items.push(t);
      if (k.tag) { items.push({ t: 'rect', x: x + 22, y: y + t.h + 13, w: textWidth(k.tag, 11) + 12, h: 18, r: 2, fill: theme.accentTint }); items.push(textItem(k.tag, x + 28, y + t.h + 14, { size: 11, color: theme.accent })); }
      y += h + 8;
    }
    bottom = Math.max(bottom, top + Math.max(colH, 120));
  });
  return { width, height: bottom + 30, items };
}

/** 对照/权限矩阵：yes 实心圆、partial 半圆、no 空心圆；其它文字原样写进格子 */
export function matrixChart(data, theme) {
  const rows = list(data.rows, '行rows', 1, 24).map((r, i) => label(r, `第${i + 1}行`, 16)), cols = list(data.columns, '列columns', 1, 10).map((c, i) => label(c, `第${i + 1}列`, 10));
  const cells = list(data.cells, '格子cells', rows.length, rows.length).map((r, i) => list(r, `第${i + 1}行格子`, cols.length, cols.length).map(v => String(v ?? '').trim().slice(0, 12)));
  const labelW = Math.max(...rows.map(r => textWidth(r, 13))) + 24, cell = 96, width = Math.max(640, 40 + labelW + cols.length * cell + 40), items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const x = 40 + labelW;
  cols.forEach((c, j) => items.push(textItem(c, x + j * cell, top, { size: 12, color: theme.ink, weight: 700, w: cell, anchor: 'middle', maxRows: 2 })));
  const y0 = top + 44, h = 36;
  rows.forEach((r, i) => {
    const y = y0 + i * h;
    if (i % 2 === 0) items.push({ t: 'rect', x: 40, y, w: width - 80, h, fill: theme.panel });
    items.push(textItem(r, 48, y + 9, { size: 13, color: theme.ink }));
    cells[i].forEach((v, j) => {
      const cx = x + j * cell + cell / 2, cy = y + h / 2, key = v.toLowerCase();
      if (['yes', '是', '有', '✓', 'y', 'true'].includes(key)) items.push({ t: 'ellipse', cx, cy, rx: 7, ry: 7, fill: theme.accent });
      else if (['partial', '部分', 'half'].includes(key)) { items.push({ t: 'ellipse', cx, cy, rx: 7, ry: 7, fill: theme.background, stroke: theme.accent, sw: 2 }); items.push({ t: 'polygon', points: [[cx, cy - 7], [cx + 7, cy], [cx, cy + 7]], fill: theme.accent }); }
      else if (['no', '否', '无', 'n', 'false', '-', ''].includes(key)) items.push({ t: 'ellipse', cx, cy, rx: 6, ry: 6, fill: theme.background, stroke: theme.soft, sw: 1.5 });
      else items.push(textItem(v, x + j * cell + 4, y + 9, { size: 12, color: theme.ink, w: cell - 8, anchor: 'middle', maxRows: 1 }));
    });
  });
  const legendY = y0 + rows.length * h + 14;
  items.push({ t: 'ellipse', cx: 52, cy: legendY + 8, rx: 6, ry: 6, fill: theme.accent }, textItem('有', 64, legendY, { size: 12, color: theme.muted }),
    { t: 'ellipse', cx: 104, cy: legendY + 8, rx: 6, ry: 6, fill: theme.background, stroke: theme.accent, sw: 2 }, { t: 'polygon', points: [[104, legendY + 2], [110, legendY + 8], [104, legendY + 14]], fill: theme.accent }, textItem('部分', 116, legendY, { size: 12, color: theme.muted }),
    { t: 'ellipse', cx: 168, cy: legendY + 8, rx: 6, ry: 6, fill: theme.background, stroke: theme.soft, sw: 1.5 }, textItem('无', 180, legendY, { size: 12, color: theme.muted }));
  return { width, height: legendY + 36, items };
}

/** 阶段 × 行的格子图：旅程、服务蓝图、故事地图共用 */
function stageGrid(items, theme, { top, stages, rows, labelW, colW, visibilityAfter = -1, emotion = null }) {
  const x0 = 40 + labelW;
  stages.forEach((s, j) => { items.push({ t: 'rect', x: x0 + j * colW + 2, y: top, w: colW - 4, h: 34, r: 4, fill: theme.accent }); items.push(textItem(s, x0 + j * colW + 6, top + 8, { size: 13, weight: 700, color: '#FFFFFF', w: colW - 12, anchor: 'middle', maxRows: 1 })); });
  let y = top + 44;
  rows.forEach((r, i) => {
    const texts = r.cells.map((c, j) => (c ? textItem(c, x0 + j * colW + 10, 0, { size: 12, color: theme.ink, w: colW - 20, maxRows: 5 }) : null));
    const h = Math.max(48, ...texts.filter(Boolean).map(t => t.h + 20));
    items.push({ t: 'rect', x: 40, y, w: labelW - 8, h, r: 4, fill: theme.panel });
    items.push(textItem(r.label, 48, y + 10, { size: 13, weight: 700, color: theme.ink, w: labelW - 24, maxRows: 3 }));
    texts.forEach((t, j) => { if (!t) return; items.push({ t: 'rect', x: x0 + j * colW + 4, y, w: colW - 8, h, r: 4, fill: theme.background, stroke: theme.rule }); t.y = y + 10; items.push(t); });
    y += h + 8;
    // 可见线单独留一条空隙，说明文字不压格子
    if (i === visibilityAfter) { items.push({ t: 'line', x1: 40, y1: y + 2, x2: x0 + stages.length * colW, y2: y + 2, stroke: theme.bad, sw: 1.5, dash: '6 4' }); items.push(textItem('可见线（以下用户看不到）', x0 + stages.length * colW, y + 6, { size: 11, color: theme.bad, anchor: 'end' })); y += 28; }
  });
  if (emotion) {
    const h = 110, mid = y + h / 2, pts = emotion.map((v, j) => [x0 + j * colW + colW / 2, mid - v * 22]);
    items.push({ t: 'rect', x: 40, y, w: labelW - 8, h, r: 4, fill: theme.panel }, textItem('感受', 48, y + 10, { size: 13, weight: 700, color: theme.ink }));
    items.push({ t: 'line', x1: x0, y1: mid, x2: x0 + stages.length * colW, y2: mid, stroke: theme.rule, dash: '3 3' }, { t: 'poly', points: pts, stroke: theme.accent, sw: 2.5 });
    pts.forEach(([px, py], j) => items.push({ t: 'ellipse', cx: px, cy: py, rx: 5, ry: 5, fill: emotion[j] < 0 ? theme.bad : emotion[j] > 0 ? theme.good : theme.soft }));
    y += h + 8;
  }
  return y;
}
const stagesOf = data => list(data.stages, '阶段stages', 2, 8).map((s, i) => label(s, `第${i + 1}个阶段`, 10));
const cellsOf = (v, n, what) => list(v || [], what, n, n).map(c => optional(c, what, 60));

export function journeyChart(data, theme) {
  const stages = stagesOf(data), rows = list(data.rows, '行rows（如行为、触点、想法）', 1, 6).map((r, i) => ({ label: label(r?.label, `第${i + 1}行名`, 8), cells: cellsOf(r?.cells, stages.length, `第${i + 1}行cells`) }));
  const emotion = data.emotion ? list(data.emotion, '感受emotion', stages.length, stages.length).map(v => { const n = Number(v); if (!(n >= -2 && n <= 2)) throw sceneError('感受emotion每项在-2到2之间'); return n; }) : null;
  const labelW = 110, colW = 170, width = 40 + labelW + stages.length * colW + 40, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  return { width, height: stageGrid(items, theme, { top, stages, rows, labelW, colW, emotion }) + 24, items };
}
export function blueprintChart(data, theme) {
  const stages = stagesOf(data);
  const names = [['customer', '用户行为'], ['frontstage', '前台（用户可见）'], ['backstage', '后台'], ['support', '支撑系统']];
  const rows = names.filter(([k]) => data[k]).map(([k, name]) => ({ label: name, cells: cellsOf(data[k], stages.length, name) }));
  if (rows.length < 3) throw sceneError('服务蓝图至少要customer、frontstage、backstage三行');
  const labelW = 120, colW = 170, width = 40 + labelW + stages.length * colW + 40, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  return { width, height: stageGrid(items, theme, { top, stages, rows, labelW, colW, visibilityAfter: 1 }) + 24, items };
}
export function storyMapChart(data, theme) {
  const backbone = list(data.backbone, '主线步骤backbone', 2, 8).map((s, i) => label(s, `第${i + 1}个主线步骤`, 10));
  const releases = list(data.releases, '版本releases', 1, 5).map((r, i) => ({ label: label(r?.label, `第${i + 1}个版本名`, 8), cells: list(r?.items, `第${i + 1}个版本items`, backbone.length, backbone.length).map(c => (Array.isArray(c) ? c : c ? [c] : []).map(t => label(t, '用户故事', 30)).join('\n')) }));
  const labelW = 100, colW = 170, width = 40 + labelW + backbone.length * colW + 40, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const y = stageGrid(items, theme, { top, stages: backbone, rows: releases.map(r => ({ label: r.label, cells: r.cells.map(c => c || '') })), labelW, colW });
  return { width, height: y + 24, items };
}

export function layersChart(data, theme) {
  const layers = list(data.layers, '层layers（从上到下）', 2, 8).map((l, i) => ({ title: label(l?.title, `第${i + 1}层名`, 10), items: list(l?.items || [], `第${i + 1}层items`, 0, 8).map(t => label(t, '模块名', 16)), focus: l?.focus === true }));
  const width = 960, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: 880 }), labelW = 130;
  let y = top;
  layers.forEach(l => {
    const n = Math.max(1, l.items.length), cw = (width - 80 - labelW - 16 - (n - 1) * 10) / n;
    const texts = l.items.map((t, j) => textItem(t, 40 + labelW + 8 + j * (cw + 10), 0, { size: 13, color: theme.ink, w: cw - 12, anchor: 'middle', maxRows: 2 }));
    const h = Math.max(64, ...texts.map(t => t.h + 30));
    items.push({ t: 'rect', x: 40, y, w: width - 80, h, r: 6, fill: l.focus ? theme.accentTint : theme.panel, stroke: l.focus ? theme.accent : theme.rule, sw: l.focus ? 2 : 1 });
    items.push(textItem(l.title, 52, y + h / 2 - 10, { size: 14, weight: 700, color: l.focus ? theme.accent : theme.ink, w: labelW - 20, maxRows: 2 }));
    texts.forEach((t, j) => { const bx = 40 + labelW + 8 + j * (cw + 10); items.push({ t: 'rect', x: bx, y: y + 12, w: cw, h: h - 24, r: 4, fill: theme.background, stroke: theme.rule }); t.x = bx + 6; t.y = y + h / 2 - t.h / 2; items.push(t); });
    y += h + 10;
  });
  return { width, height: y + 20, items };
}

/** 嵌套范围：容器套容器（最多3层），子项按网格排 */
export function nestedChart(data, theme) {
  const norm = (n, depth, path) => {
    if (depth > 3) throw sceneError('嵌套最多3层');
    const kids = list(n?.children || [], `${path}的children`, 0, 12).map((c, i) => norm(c, depth + 1, `${path}第${i + 1}项`));
    return { title: label(n?.title, `${path}名称`, 16), note: optional(n?.note, '说明', 30), children: kids };
  };
  const root = norm(data.root, 1, '最外层');
  const measure = (n, w) => {
    if (!n.children.length) { const t = textItem(n.title, 0, 0, { size: 13, w: w - 16, maxRows: 2 }); return { w, h: t.h + 22 + (n.note ? 18 : 0) }; }
    const cols = Math.min(n.children.length, w > 600 ? 3 : 2), cw = (w - 24 - (cols - 1) * 12) / cols;
    const sizes = n.children.map(c => measure(c, cw)), rowsH = [];
    sizes.forEach((s, i) => { const r = Math.floor(i / cols); rowsH[r] = Math.max(rowsH[r] || 0, s.h); });
    return { w, h: 40 + rowsH.reduce((s, v) => s + v + 12, 0) + 4, cols, cw, rowsH, sizes };
  };
  const items = [], width = 960, top = titleBlock(items, data.title, data.subtitle, theme, { w: 880 });
  const draw = (n, x, y, m, depth) => {
    const leaf = !n.children.length;
    items.push({ t: 'rect', x, y, w: m.w, h: m.h, r: 6, fill: leaf ? theme.background : depth === 1 ? theme.panel : theme.background, stroke: depth === 1 ? theme.accent : theme.soft, sw: depth === 1 ? 2 : 1, ...(depth > 1 && !leaf && { dash: '6 4' }) });
    items.push(textItem(n.title, x + 12, y + 10, { size: leaf ? 13 : 14, weight: 700, color: depth === 1 ? theme.accent : theme.ink, w: m.w - 24, maxRows: 2 }));
    if (n.note) items.push(textItem(n.note, x + 12, y + (leaf ? 30 : 30), { size: 11, color: theme.muted }));
    if (leaf) return;
    let cy = y + 40 + (n.note ? 14 : 0);
    n.children.forEach((c, i) => {
      const col = i % m.cols, row = Math.floor(i / m.cols);
      if (col === 0 && i) cy += m.rowsH[row - 1] + 12;
      draw(c, x + 12 + col * (m.cw + 12), cy, { ...m.sizes[i], h: m.rowsH[row] }, depth + 1);
    });
  };
  const m = measure(root, width - 80);
  if (root.note) m.h += 14;
  draw(root, 40, top, m, 1);
  return { width, height: top + m.h + 30, items };
}
export const BOARD_CHARTS = { gantt: ganttChart, timeline: timelineChart, kanban: kanbanChart, matrix: matrixChart, journey: journeyChart, blueprint: blueprintChart, storymap: storyMapChart, layers: layersChart, nested: nestedChart };
