/**
 * 数据图表（程序按数值画，数字原样标注，不让生图模型画图表）。
 * 柱状、折线、饼/环、散点/气泡、雷达、热力、矩形树、瀑布、漏斗、金字塔、韦恩、桑基、象限。
 * 每个函数：(data, theme) → { width, height, items }，图元见 chartScene.js。
 */
import { sceneError, textItem, titleBlock, legendStrip, niceTicks, fmt, textWidth } from './chartScene.js';

const num = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw sceneError(`${what}必须是数字`); return v; };
const list = (v, what, min, max) => { if (!Array.isArray(v) || v.length < min || v.length > max) throw sceneError(`${what}需要${min}–${max}项`); return v; };
const label = (v, what, max = 30) => { const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''; if (!s) throw sceneError(`${what}不能为空`); if ([...s].length > max) throw sceneError(`${what}“${s.slice(0, 10)}…”超过${max}字，请精简`); return s; };

/** 坐标轴区域：y 刻度、网格线、x 分类标签 */
function axes(items, theme, { x, y, w, h, ticks, unit, categories, band }) {
  const lo = ticks[0], hi = ticks.at(-1), Y = v => y + h - (v - lo) / (hi - lo) * h;
  for (const t of ticks) {
    items.push({ t: 'line', x1: x, y1: Y(t), x2: x + w, y2: Y(t), stroke: t === 0 ? theme.soft : theme.rule, sw: 1 });
    items.push(textItem(fmt(t, unit), x - 8, Y(t) - 8, { size: 12, color: theme.muted, anchor: 'end' }));
  }
  categories.forEach((c, i) => items.push(textItem(c, x + band * i + 4, y + h + 8, { size: 12, color: theme.muted, w: band - 8, anchor: 'middle', maxRows: 2, what: '分类' })));
  return Y;
}
function seriesInput(data, n) {
  const categories = list(data.categories, '分类categories', 1, 24).map((c, i) => label(c, `第${i + 1}个分类`, 16));
  const series = list(data.series, '数据系列series', 1, 6).map((s, i) => ({ name: label(s?.name ?? `系列${i + 1}`, '系列名', 16), values: list(s?.values, `系列${i + 1}的values`, categories.length, categories.length).map(v => num(v, '数值')) }));
  return { categories, series, unit: typeof data.unit === 'string' ? data.unit.slice(0, 6) : '', n };
}

export function barChart(data, theme) {
  const { categories, series, unit } = seriesInput(data);
  const items = [], width = Math.max(720, 120 + categories.length * series.length * 34 + categories.length * 24), x = 80;
  const top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const all = series.flatMap(s => s.values), ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const w = width - x - 40, h = 340, band = w / categories.length, bar = Math.min(48, (band * 0.72) / series.length);
  const Y = axes(items, theme, { x, y: top, w, h, ticks, unit, categories, band });
  series.forEach((s, k) => s.values.forEach((v, i) => {
    const bx = x + band * i + (band - bar * series.length) / 2 + bar * k, y0 = Y(0), y1 = Y(v);
    items.push({ t: 'rect', x: bx, y: Math.min(y0, y1), w: bar - 4, h: Math.max(1, Math.abs(y1 - y0)), fill: series.length === 1 ? (v < 0 ? theme.bad : theme.accent) : theme.series[k] });
    items.push(textItem(fmt(v, unit), bx + (bar - 4) / 2, v >= 0 ? y1 - 20 : y1 + 4, { size: 12, color: theme.ink, anchor: 'middle' }));
  }));
  let bottom = top + h + 48;
  if (series.length > 1) bottom = legendStrip(items, series.map((s, k) => ({ label: s.name, color: theme.series[k] })), x, bottom, theme);
  return { width, height: bottom + 24, items };
}

export function lineChart(data, theme) {
  const { categories, series, unit } = seriesInput(data);
  const items = [], width = Math.max(720, 120 + categories.length * 56), x = 80;
  const top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const all = series.flatMap(s => s.values), ticks = niceTicks(Math.min(...all), Math.max(...all));
  const w = width - x - 40, h = 320, band = w / categories.length;
  const Y = axes(items, theme, { x, y: top, w, h, ticks, unit, categories, band });
  series.forEach((s, k) => {
    const color = series.length === 1 ? theme.accent : theme.series[k], pts = s.values.map((v, i) => [x + band * (i + 0.5), Y(v)]);
    items.push({ t: 'poly', points: pts, stroke: color, sw: 2.5 });
    pts.forEach(([px, py], i) => {
      items.push({ t: 'ellipse', cx: px, cy: py, rx: 4, ry: 4, fill: theme.background, stroke: color, sw: 2 });
      if (series.length === 1 || i === pts.length - 1) items.push(textItem(fmt(s.values[i], unit), px, py - 22, { size: 12, color: theme.ink, anchor: 'middle' }));
    });
  });
  let bottom = top + h + 48;
  if (series.length > 1) bottom = legendStrip(items, series.map((s, k) => ({ label: s.name, color: theme.series[k] })), x, bottom, theme);
  return { width, height: bottom + 24, items };
}

/** 扇形：用多边形逼近圆弧，PPT 里是可编辑的自定义形状 */
function sector(cx, cy, r0, r1, a0, a1) {
  const steps = Math.max(2, Math.ceil((a1 - a0) / (Math.PI / 36))), outer = [], inner = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    outer.push([cx + r1 * Math.cos(a), cy + r1 * Math.sin(a)]);
    if (r0) inner.unshift([cx + r0 * Math.cos(a), cy + r0 * Math.sin(a)]);
  }
  return r0 ? [...outer, ...inner] : [[cx, cy], ...outer];
}
export function pieChart(data, theme) {
  const entries = list(data.items, '扇区items', 2, 10).map((it, i) => ({ label: label(it?.label, `第${i + 1}项名称`, 16), value: num(it?.value, '数值') }));
  if (entries.some(e => e.value < 0)) throw sceneError('饼图数值不能为负');
  const total = entries.reduce((s, e) => s + e.value, 0);
  if (!total) throw sceneError('饼图数值合计不能为0');
  const items = [], width = 820, top = titleBlock(items, data.title, data.subtitle, theme, { w: 740 });
  const cx = 250, cy = top + 190, r = 170, r0 = data.donut ? 96 : 0, unit = typeof data.unit === 'string' ? data.unit.slice(0, 6) : '';
  let a = -Math.PI / 2;
  entries.forEach((e, k) => {
    const da = e.value / total * Math.PI * 2;
    items.push({ t: 'polygon', points: sector(cx, cy, r0, r, a, a + da), fill: theme.series[k % theme.series.length], stroke: theme.background, sw: 2 });
    a += da;
  });
  if (data.donut) items.push(textItem(fmt(total, unit), cx, cy - 18, { size: 24, weight: 700, color: theme.ink, anchor: 'middle' }), textItem('合计', cx, cy + 12, { size: 12, color: theme.muted, anchor: 'middle' }));
  // 右侧图例带数值和占比，不把小字塞进扇区
  entries.forEach((e, k) => {
    const ly = top + 30 + k * 34;
    items.push({ t: 'rect', x: 470, y: ly + 3, w: 14, h: 14, r: 2, fill: theme.series[k % theme.series.length] });
    // 单位本来就是%时不再重复写占比
    items.push(textItem(unit === '%' ? `${e.label}  ${fmt(e.value, unit)}` : `${e.label}  ${fmt(e.value, unit)}（${Math.round(e.value / total * 1000) / 10}%）`, 494, ly, { size: 14, color: theme.ink, w: 300, maxRows: 2 }));
  });
  return { width, height: Math.max(cy + r + 40, top + 30 + entries.length * 34 + 30), items };
}

export function scatterChart(data, theme) {
  const pts = list(data.points, '点points', 2, 200).map((p, i) => ({ x: num(p?.x, '横坐标x'), y: num(p?.y, '纵坐标y'), size: p?.size === undefined ? null : num(p.size, '气泡大小'), label: p?.label ? label(p.label, `第${i + 1}个点名称`, 12) : '' }));
  const items = [], width = 820, x = 90, top = titleBlock(items, data.title, data.subtitle, theme, { w: 720 });
  const w = width - x - 50, h = 400;
  const xt = niceTicks(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x))), yt = niceTicks(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)));
  const X = v => x + (v - xt[0]) / (xt.at(-1) - xt[0]) * w, Y = v => top + h - (v - yt[0]) / (yt.at(-1) - yt[0]) * h;
  for (const t of yt) { items.push({ t: 'line', x1: x, y1: Y(t), x2: x + w, y2: Y(t), stroke: theme.rule }); items.push(textItem(fmt(t), x - 8, Y(t) - 8, { size: 12, color: theme.muted, anchor: 'end' })); }
  for (const t of xt) { items.push({ t: 'line', x1: X(t), y1: top, x2: X(t), y2: top + h, stroke: theme.rule }); items.push(textItem(fmt(t), X(t), top + h + 8, { size: 12, color: theme.muted, anchor: 'middle' })); }
  if (data.xLabel) items.push(textItem(label(data.xLabel, '横轴名', 20), x + w, top + h + 30, { size: 13, color: theme.ink, anchor: 'end' }));
  if (data.yLabel) items.push(textItem(label(data.yLabel, '纵轴名', 20), x, top - 24, { size: 13, color: theme.ink }));
  const maxSize = Math.max(1, ...pts.map(p => p.size || 0));
  for (const p of pts) {
    const r = p.size ? 6 + Math.sqrt(p.size / maxSize) * 24 : 6;
    items.push({ t: 'ellipse', cx: X(p.x), cy: Y(p.y), rx: r, ry: r, fill: theme.accent, opacity: p.size ? 0.45 : 0.85, stroke: theme.accent, sw: 1 });
    if (p.label) items.push(textItem(p.label, X(p.x) + r + 4, Y(p.y) - 8, { size: 12, color: theme.ink }));
  }
  return { width, height: top + h + 64, items };
}

export function radarChart(data, theme) {
  const axesNames = list(data.axes, '维度axes', 3, 10).map((a, i) => label(a, `第${i + 1}个维度`, 10));
  const series = list(data.series, '对象series', 1, 4).map((s, i) => ({ name: label(s?.name ?? `对象${i + 1}`, '对象名', 12), values: list(s?.values, `对象${i + 1}的values`, axesNames.length, axesNames.length).map(v => num(v, '分值')) }));
  const max = data.max === undefined ? Math.max(...series.flatMap(s => s.values)) : num(data.max, '满分max');
  if (!(max > 0) || series.some(s => s.values.some(v => v < 0 || v > max))) throw sceneError('雷达图分值需在0到满分之间');
  const items = [], width = 760, top = titleBlock(items, data.title, data.subtitle, theme, { w: 680 }), cx = 380, cy = top + 230, R = 180;
  const at = (i, r) => [cx + r * Math.sin(i / axesNames.length * Math.PI * 2), cy - r * Math.cos(i / axesNames.length * Math.PI * 2)];
  for (const f of [0.25, 0.5, 0.75, 1]) items.push({ t: 'polygon', points: axesNames.map((_, i) => at(i, R * f)), stroke: theme.rule, sw: 1 });
  axesNames.forEach((name, i) => {
    const [px, py] = at(i, R), [lx, ly] = at(i, R + 26);
    items.push({ t: 'line', x1: cx, y1: cy, x2: px, y2: py, stroke: theme.rule });
    items.push(textItem(name, lx, ly - 9, { size: 13, color: theme.ink, anchor: Math.abs(lx - cx) < 10 ? 'middle' : lx > cx ? 'start' : 'end' }));
  });
  series.forEach((s, k) => items.push({ t: 'polygon', points: s.values.map((v, i) => at(i, R * v / max)), fill: theme.series[k], opacity: 0.18, stroke: theme.series[k], sw: 2 }));
  const bottom = legendStrip(items, series.map((s, k) => ({ label: s.name, color: theme.series[k] })), 60, cy + R + 50, theme);
  return { width, height: bottom + 20, items };
}

export function heatmapChart(data, theme) {
  const rows = list(data.rows, '行rows', 1, 20).map((r, i) => label(r, `第${i + 1}行`, 12)), cols = list(data.columns, '列columns', 1, 16).map((c, i) => label(c, `第${i + 1}列`, 10));
  const values = list(data.values, '数值values', rows.length, rows.length).map((r, i) => list(r, `第${i + 1}行数值`, cols.length, cols.length).map(v => num(v, '数值')));
  const flat = values.flat(), lo = Math.min(...flat), hi = Math.max(...flat), unit = typeof data.unit === 'string' ? data.unit.slice(0, 6) : '';
  const cell = 64, x = 40 + Math.max(...rows.map(r => textWidth(r, 13))) + 12, items = [];
  const width = Math.max(640, x + cols.length * cell + 40), top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  cols.forEach((c, j) => items.push(textItem(c, x + j * cell, top, { size: 12, color: theme.muted, w: cell, anchor: 'middle', maxRows: 2 })));
  const y0 = top + 40;
  // 单色深浅表示大小；深格子用白字
  const mix = t => { const a = [255, 255, 255], b = theme.accent.match(/\w\w/g).map(h => parseInt(h, 16)); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase(); };
  rows.forEach((r, i) => {
    items.push(textItem(r, 40, y0 + i * cell + cell / 2 - 9, { size: 13, color: theme.ink }));
    values[i].forEach((v, j) => {
      const t = hi === lo ? 0.5 : 0.08 + (v - lo) / (hi - lo) * 0.92;
      items.push({ t: 'rect', x: x + j * cell + 2, y: y0 + i * cell + 2, w: cell - 4, h: cell - 4, r: 3, fill: mix(t) });
      items.push(textItem(fmt(v, unit), x + j * cell + cell / 2, y0 + i * cell + cell / 2 - 9, { size: 13, color: t > 0.55 ? '#FFFFFF' : theme.ink, anchor: 'middle' }));
    });
  });
  return { width, height: y0 + rows.length * cell + 32, items };
}

/** 矩形树图：按面积占比切分（squarify 思路，交替横竖切） */
export function treemapChart(data, theme) {
  const entries = list(data.items, '项目items', 2, 30).map((it, i) => ({ label: label(it?.label, `第${i + 1}项名称`, 16), value: num(it?.value, '数值') })).sort((a, b) => b.value - a.value);
  if (entries.some(e => e.value <= 0)) throw sceneError('矩形树图数值需大于0');
  const items = [], width = 900, top = titleBlock(items, data.title, data.subtitle, theme, { w: 820 }), unit = typeof data.unit === 'string' ? data.unit.slice(0, 6) : '';
  const total = entries.reduce((s, e) => s + e.value, 0);
  const place = (list, box, vertical) => {
    if (!list.length) return;
    if (list.length === 1) { draw(list[0], box); return; }
    const sum = list.reduce((s, e) => s + e.value, 0);
    let acc = 0, k = 0;
    while (k < list.length - 1 && acc + list[k].value <= sum / 2) acc += list[k++].value;
    if (k === 0) acc = list[k++].value;
    const f = acc / sum;
    const [a, b] = vertical ? [{ ...box, w: box.w * f }, { ...box, x: box.x + box.w * f, w: box.w * (1 - f) }] : [{ ...box, h: box.h * f }, { ...box, y: box.y + box.h * f, h: box.h * (1 - f) }];
    place(list.slice(0, k), a, a.w < a.h ? false : true);
    place(list.slice(k), b, b.w < b.h ? false : true);
  };
  const colorOf = new Map(entries.map((e, i) => [e, theme.series[i % theme.series.length]]));
  const draw = (e, b) => {
    items.push({ t: 'rect', x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4, r: 3, fill: colorOf.get(e) });
    if (b.w > 70 && b.h > 56) {
      items.push(textItem(e.label, b.x + 10, b.y + 8, { size: 14, weight: 700, color: '#FFFFFF', w: b.w - 20, maxRows: 2, what: '名称' }));
      items.push(textItem(`${fmt(e.value, unit)} · ${Math.round(e.value / total * 1000) / 10}%`, b.x + 10, b.y + 30 + (textWidth(e.label, 14) > b.w - 20 ? 20 : 0), { size: 12, color: '#FFFFFF' }));
    }
  };
  place(entries, { x: 40, y: top, w: width - 80, h: 460 }, true);
  // 太小放不下字的块，在下方列表里补全名称和数值，不丢信息
  const small = entries.filter(e => { const r = items.find(it => it.t === 'rect' && it.fill === colorOf.get(e)); return r && (r.w < 74 || r.h < 60); });
  let bottom = top + 470;
  if (small.length) { const note = textItem('小块：' + small.map(e => `${e.label} ${fmt(e.value, unit)}`).join('；'), 40, bottom, { size: 12, color: theme.muted, w: width - 80, maxRows: 4 }); items.push(note); bottom += note.h + 8; }
  return { width, height: bottom + 20, items };
}

export function waterfallChart(data, theme) {
  const start = { label: label(data.start?.label, '起点名称', 12), value: num(data.start?.value, '起点数值') };
  const steps = list(data.steps, '变化steps', 1, 16).map((s, i) => ({ label: label(s?.label, `第${i + 1}项名称`, 12), value: num(s?.value, '变化值') }));
  const endLabel = label(data.endLabel || '期末', '终点名称', 12), unit = typeof data.unit === 'string' ? data.unit.slice(0, 6) : '';
  const bars = [{ ...start, base: 0, total: true }];
  let run = start.value;
  for (const s of steps) { bars.push({ ...s, base: run }); run += s.value; }
  bars.push({ label: endLabel, value: run, base: 0, total: true });
  const items = [], width = Math.max(720, 120 + bars.length * 70), x = 80, top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const vals = bars.flatMap(b => [b.base, b.base + b.value]), ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const w = width - x - 40, h = 340, band = w / bars.length;
  const Y = axes(items, theme, { x, y: top, w, h, ticks, unit, categories: bars.map(b => b.label), band });
  bars.forEach((b, i) => {
    const y1 = Y(b.base), y2 = Y(b.base + b.value), bx = x + band * i + band * 0.18, bw = band * 0.64;
    items.push({ t: 'rect', x: bx, y: Math.min(y1, y2), w: bw, h: Math.max(1, Math.abs(y2 - y1)), fill: b.total ? theme.muted : b.value >= 0 ? theme.good : theme.bad });
    items.push(textItem((b.total || b.value < 0 ? '' : '+') + fmt(b.value, unit), bx + bw / 2, Math.min(y1, y2) - 20, { size: 12, color: theme.ink, anchor: 'middle' }));
    if (i < bars.length - 1) items.push({ t: 'line', x1: bx + bw, y1: Y(b.base + b.value), x2: bx + band, y2: Y(b.base + b.value), stroke: theme.soft, dash: '3 3' });
  });
  return { width, height: top + h + 70, items };
}

export function funnelChart(data, theme) {
  const stages = list(data.stages, '阶段stages', 2, 8).map((s, i) => ({ label: label(s?.label, `第${i + 1}阶段`, 14), value: num(s?.value, '数值') }));
  const items = [], width = 820, top = titleBlock(items, data.title, data.subtitle, theme, { w: 740 }), unit = typeof data.unit === 'string' ? data.unit.slice(0, 6) : '';
  const max = Math.max(...stages.map(s => s.value)), cx = 300, h = 58, W = 440;
  stages.forEach((s, i) => {
    // 宽度按开平方缩放：转化率常常差几十倍，线性会让后几层细得看不见；准确数值写在右侧
    const wOf = v => W * (0.22 + 0.78 * Math.sqrt(v / max)), w0 = wOf(s.value), w1 = i < stages.length - 1 ? wOf(stages[i + 1].value) : w0 * 0.85, y = top + i * (h + 6);
    items.push({ t: 'polygon', points: [[cx - w0 / 2, y], [cx + w0 / 2, y], [cx + w1 / 2, y + h], [cx - w1 / 2, y + h]], fill: theme.series[i % theme.series.length] });
    items.push(textItem(`${s.label}`, 560, y + 8, { size: 14, weight: 700, color: theme.ink }));
    items.push(textItem(`${fmt(s.value, unit)}${i ? `（上一步的${Math.round(s.value / stages[i - 1].value * 1000) / 10}%）` : ''}`, 560, y + 30, { size: 12, color: theme.muted }));
  });
  return { width, height: top + stages.length * (h + 6) + 30, items };
}

export function pyramidChart(data, theme) {
  const levels = list(data.levels, '层级levels', 2, 7).map((l, i) => ({ label: label(l?.label, `第${i + 1}层`, 12), note: l?.note ? label(l.note, '说明', 40) : '' }));
  const items = [], width = 860, top = titleBlock(items, data.title, data.subtitle, theme, { w: 780 }), h = 64, cx = 290, W = 460, n = levels.length;
  levels.forEach((l, i) => {
    // 塔尖留出能放下文字的宽度
    const y = top + i * (h + 4), w0 = W * (i + 0.6) / (n + 0.6), w1 = W * (i + 1.6) / (n + 0.6);
    items.push({ t: 'polygon', points: [[cx - w0 / 2, y], [cx + w0 / 2, y], [cx + w1 / 2, y + h], [cx - w1 / 2, y + h]], fill: i === 0 ? theme.accent : theme.series[(i + 1) % theme.series.length], opacity: i === 0 ? 1 : 0.85 });
    items.push(textItem(l.label, cx, y + h / 2 - 10, { size: 14, weight: 700, color: '#FFFFFF', anchor: 'middle' }));
    if (l.note) items.push(textItem(l.note, 560, y + h / 2 - 10, { size: 13, color: theme.ink, w: 260, maxRows: 2 }));
  });
  return { width, height: top + n * (h + 4) + 30, items };
}

export function vennChart(data, theme) {
  const sets = list(data.sets, '集合sets', 2, 3).map((s, i) => ({ label: label(s?.label, `第${i + 1}个集合`, 12), note: s?.note ? label(s.note, '说明', 30) : '' }));
  const items = [], width = 760, top = titleBlock(items, data.title, data.subtitle, theme, { w: 680 }), r = 150, cx = 380, cy = top + 200;
  const centers = sets.length === 2 ? [[cx - 90, cy], [cx + 90, cy]] : [[cx - 90, cy - 50], [cx + 90, cy - 50], [cx, cy + 100]];
  sets.forEach((s, i) => items.push({ t: 'ellipse', cx: centers[i][0], cy: centers[i][1], rx: r, ry: r, fill: theme.series[i], opacity: 0.22, stroke: theme.series[i], sw: 2 }));
  sets.forEach((s, i) => {
    const [x, y] = centers[i], dx = x - cx;
    const lx = x + Math.sign(dx) * 60, ly = sets.length === 3 && i === 2 ? y + 60 : y - 20;
    items.push(textItem(s.label, lx, ly, { size: 15, weight: 700, color: theme.ink, anchor: 'middle' }));
    if (s.note) items.push(textItem(s.note, lx - 60, ly + 24, { size: 12, color: theme.muted, w: 120, anchor: 'middle', maxRows: 3 }));
  });
  if (data.overlap) items.push(textItem(label(data.overlap, '交集说明', 16), cx, sets.length === 2 ? cy - 10 : cy, { size: 13, weight: 700, color: theme.ink, anchor: 'middle' }));
  return { width, height: cy + r + (sets.length === 3 ? 120 : 40), items };
}

/** 桑基图：节点按层排列，带宽=数量；带子用多边形近似贝塞尔曲线 */
export function sankeyChart(data, theme) {
  const nodes = list(data.nodes, '节点nodes', 2, 24).map((n, i) => ({ id: label(n?.id, `第${i + 1}个节点id`, 40), label: label(n?.label ?? n?.id, '节点名', 12), in: 0, out: 0 }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const links = list(data.links, '流向links', 1, 60).map((l, i) => {
    if (!byId.has(l?.from) || !byId.has(l?.to) || l.from === l.to) throw sceneError(`第${i + 1}条流向的from/to需为不同的已有节点`);
    const value = num(l.value, '流量');
    if (value <= 0) throw sceneError('流量需大于0');
    return { from: byId.get(l.from), to: byId.get(l.to), value };
  });
  for (const l of links) { l.from.out += l.value; l.to.in += l.value; }
  // 分层：最长路径
  const depth = new Map(nodes.map(n => [n, 0]));
  for (let pass = 0; pass < nodes.length; pass++) for (const l of links) depth.set(l.to, Math.max(depth.get(l.to), depth.get(l.from) + 1));
  const layers = Math.max(...depth.values()) + 1;
  if (layers > 8) throw sceneError('桑基图层数过多或有循环，请检查流向');
  const items = [], width = Math.max(820, layers * 200), top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 }), H = 420, colW = 18, unit = typeof data.unit === 'string' ? data.unit.slice(0, 6) : '';
  const cols = Array.from({ length: layers }, (_, d) => nodes.filter(n => depth.get(n) === d));
  const scale = Math.min(...cols.map(c => (H - 14 * (c.length - 1)) / c.reduce((s, n) => s + Math.max(n.in, n.out), 0)));
  const gapX = (width - 160 - colW) / Math.max(1, layers - 1);
  cols.forEach((c, d) => {
    let y = top;
    c.forEach((n, k) => {
      n.x = 80 + d * gapX; n.y = y; n.h = Math.max(n.in, n.out) * scale; n.outY = y; n.inY = y; y += n.h + 14;
      items.push({ t: 'rect', x: n.x, y: n.y, w: colW, h: Math.max(2, n.h), fill: theme.series[(d + k) % theme.series.length] });
    });
  });
  for (const l of links.sort((a, b) => a.to.y - b.to.y)) {
    const w = l.value * scale, x0 = l.from.x + colW, x1 = l.to.x, y0 = l.from.outY, y1 = l.to.inY, pts = [], back = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, s = t * t * (3 - 2 * t), x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * s;
      pts.push([x, y]); back.unshift([x, y + w]);
    }
    items.unshift({ t: 'polygon', points: [...pts, ...back], fill: theme.soft, opacity: 0.35 });
    l.from.outY += w; l.to.inY += w;
  }
  for (const n of nodes) {
    const last = depth.get(n) === layers - 1;
    items.push(textItem(`${n.label} ${fmt(Math.max(n.in, n.out), unit)}`, last ? n.x - 6 : n.x + colW + 6, n.y + n.h / 2 - 9, { size: 12, color: theme.ink, anchor: last ? 'end' : 'start' }));
  }
  return { width, height: top + H + 40, items };
}

export function quadrantChart(data, theme) {
  const xa = { low: label(data.xAxis?.low, '横轴低端', 10), high: label(data.xAxis?.high, '横轴高端', 10), name: data.xAxis?.label ? label(data.xAxis.label, '横轴名', 12) : '' };
  const ya = { low: label(data.yAxis?.low, '纵轴低端', 10), high: label(data.yAxis?.high, '纵轴高端', 10), name: data.yAxis?.label ? label(data.yAxis.label, '纵轴名', 12) : '' };
  const quads = list(data.quadrants, '四个象限名quadrants（右上、左上、左下、右下）', 4, 4).map((q, i) => label(q, `第${i + 1}个象限名`, 14));
  const pts = list(data.items || [], '点items', 0, 30).map((p, i) => ({ label: label(p?.label, `第${i + 1}个点`, 12), x: num(p?.x, '横向位置x'), y: num(p?.y, '纵向位置y'), focus: p?.focus === true }));
  if (pts.some(p => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) throw sceneError('象限图的点位置x/y需在0到1之间（0为低端，1为高端）');
  if (pts.filter(p => p.focus).length > 2) throw sceneError('重点点最多2个');
  const items = [], width = 820, top = titleBlock(items, data.title, data.subtitle, theme, { w: 740 }), x = 110, S = 560, y = top + 10;
  [[1, 0], [0, 0], [0, 1], [1, 1]].forEach(([qx, qy], i) => {
    items.push({ t: 'rect', x: x + qx * S / 2, y: y + qy * S / 2, w: S / 2, h: S / 2, fill: i === 0 ? theme.accentTint : theme.panel, stroke: theme.background, sw: 3 });
    items.push(textItem(quads[i], x + qx * S / 2 + 14, y + qy * S / 2 + 12, { size: 14, weight: 700, color: theme.muted }));
  });
  items.push({ t: 'line', x1: x, y1: y + S, x2: x + S + 10, y2: y + S, stroke: theme.ink, sw: 1.5, arrow: 'end' }, { t: 'line', x1: x, y1: y + S, x2: x, y2: y - 10, stroke: theme.ink, sw: 1.5, arrow: 'end' });
  items.push(textItem(xa.low, x, y + S + 8, { size: 12, color: theme.muted }), textItem(xa.high, x + S, y + S + 8, { size: 12, color: theme.muted, anchor: 'end' }));
  items.push(textItem(ya.low, x - 8, y + S - 18, { size: 12, color: theme.muted, anchor: 'end' }), textItem(ya.high, x - 8, y, { size: 12, color: theme.muted, anchor: 'end' }));
  if (xa.name) items.push(textItem(xa.name, x + S / 2, y + S + 8, { size: 13, weight: 700, color: theme.ink, anchor: 'middle' }));
  if (ya.name) items.push(textItem(ya.name, x - 8, y + S / 2 - 9, { size: 13, weight: 700, color: theme.ink, anchor: 'end' }));
  for (const p of pts) {
    const px = x + p.x * S, py = y + (1 - p.y) * S;
    items.push({ t: 'ellipse', cx: px, cy: py, rx: p.focus ? 9 : 6, ry: p.focus ? 9 : 6, fill: p.focus ? theme.accent : theme.muted });
    items.push(textItem(p.label, px + 12, py - 9, { size: 13, color: theme.ink, weight: p.focus ? 700 : 400 }));
  }
  return { width, height: y + S + 44, items };
}
export const DATA_CHARTS = { bar: barChart, line: lineChart, pie: pieChart, scatter: scatterChart, radar: radarChart, heatmap: heatmapChart, treemap: treemapChart, waterfall: waterfallChart, funnel: funnelChart, pyramid: pyramidChart, venn: vennChart, sankey: sankeyChart, quadrant: quadrantChart };
