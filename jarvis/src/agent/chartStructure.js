/**
 * 结构类图示：时序图、ER/数据库表结构、UML 类图、鱼骨图（因果分析）。
 * 坐标由程序算：时序图按消息顺序往下排；ER/类图按网格摆放、连线走格子之间的空隙；鱼骨图主骨水平、分支上下交替。
 */
import { sceneError, textItem, titleBlock, textWidth } from './chartScene.js';

const list = (v, what, min, max) => { if (!Array.isArray(v) || v.length < min || v.length > max) throw sceneError(`${what}需要${min}–${max}项`); return v; };
const label = (v, what, max = 30) => { const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''; if (!s) throw sceneError(`${what}不能为空`); if ([...s].length > max) throw sceneError(`${what}“${s.slice(0, 10)}…”超过${max}字，请精简`); return s; };
const optional = (v, what, max) => (v === undefined || v === null || v === '' ? '' : label(v, what, max));

export function sequenceChart(data, theme) {
  const parts = list(data.participants, '参与方participants', 2, 8).map((p, i) => ({ id: label(p?.id, `第${i + 1}个参与方id`, 40), label: label(p?.label ?? p?.id, '参与方名', 12) }));
  const index = new Map(parts.map((p, i) => [p.id, i]));
  if (index.size !== parts.length) throw sceneError('参与方id不能重复');
  const msgs = list(data.messages, '消息messages', 1, 40).map((m, i) => {
    if (!index.has(m?.from) || !index.has(m?.to)) throw sceneError(`第${i + 1}条消息的from/to需为已有参与方`);
    return { from: index.get(m.from), to: index.get(m.to), text: label(m?.text, `第${i + 1}条消息`, 24), reply: m?.reply === true, note: optional(m?.note, '备注', 30) };
  });
  const colW = 170, width = 80 + parts.length * colW, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const X = i => 40 + colW / 2 + i * colW, head = 40;
  let y = top + head + 30;
  const rows = msgs.map(m => { const h = m.from === m.to ? 56 : 44; const r = { ...m, y }; y += h + (m.note ? 22 : 0); return r; });
  const bottom = y + 10;
  parts.forEach((p, i) => {
    items.push({ t: 'line', x1: X(i), y1: top + head, x2: X(i), y2: bottom, stroke: theme.soft, sw: 1, dash: '5 4' });
    for (const yy of [top, bottom]) { items.push({ t: 'rect', x: X(i) - 70, y: yy, w: 140, h: head, r: 4, fill: theme.panel, stroke: theme.accent, sw: 1.5 }); items.push(textItem(p.label, X(i) - 66, yy + 11, { size: 13, weight: 700, color: theme.ink, w: 132, anchor: 'middle', maxRows: 1 })); }
  });
  rows.forEach((m, k) => {
    const color = m.reply ? theme.muted : theme.ink, dash = m.reply ? '5 4' : undefined;
    const labelText = `${k + 1}. ${m.text}`;
    if (m.from === m.to) {
      const x = X(m.from);
      items.push({ t: 'poly', points: [[x, m.y], [x + 40, m.y], [x + 40, m.y + 26], [x + 4, m.y + 26]], stroke: color, sw: 1.5, dash, arrow: 'end' });
      items.push(textItem(labelText, x + 46, m.y + 4, { size: 12, color: theme.ink }));
    } else {
      const x1 = X(m.from), x2 = X(m.to), dir = Math.sign(x2 - x1);
      items.push({ t: 'line', x1: x1 + dir * 2, y1: m.y + 22, x2: x2 - dir * 2, y2: m.y + 22, stroke: color, sw: 1.5, dash, arrow: 'end' });
      // 文字在箭头上方、带底色，不压线
      const w = Math.min(Math.abs(x2 - x1) - 12, textWidth(labelText, 12) + 10);
      items.push({ t: 'rect', x: (x1 + x2) / 2 - w / 2, y: m.y + 2, w, h: 16, fill: theme.background });
      items.push(textItem(labelText, (x1 + x2) / 2 - w / 2, m.y + 1, { size: 12, color: theme.ink, w, anchor: 'middle', maxRows: 1, what: '消息文字' }));
    }
    if (m.note) items.push(textItem(m.note, X(Math.min(m.from, m.to)) + 6, m.y + 30, { size: 11, color: theme.muted }));
  });
  return { width, height: bottom + head + 30, items };
}

/** 表/类方框：标题栏 + 若干分区（字段、方法） */
function entityBox(e, theme, kind) {
  const sections = kind === 'uml' ? [e.fields, e.methods].filter(s => s.length) : [e.fields];
  const lines = sections.flat().map(f => f.text), w = Math.max(180, Math.min(300, Math.max(textWidth(e.title, 14), ...lines.map(t => textWidth(t, 12))) + 28));
  const h = 36 + sections.reduce((s, sec) => s + sec.length * 20 + 10, 0);
  return { ...e, w, h, sections };
}
function placeGrid(boxes, cols, gapX = 90, gapY = 70) {
  const colW = [], rowH = [];
  boxes.forEach((b, i) => { const c = i % cols, r = Math.floor(i / cols); colW[c] = Math.max(colW[c] || 0, b.w); rowH[r] = Math.max(rowH[r] || 0, b.h); });
  boxes.forEach((b, i) => { const c = i % cols, r = Math.floor(i / cols); b.x = 40 + colW.slice(0, c).reduce((s, v) => s + v + gapX, 0); b.y = rowH.slice(0, r).reduce((s, v) => s + v + gapY, 0); b.col = c; b.row = r; });
  return { width: 40 + colW.reduce((s, v) => s + v + gapX, 0) - gapX + 40, height: rowH.reduce((s, v) => s + v + gapY, 0) - gapY };
}
function entityDiagram(data, theme, kind) {
  const entities = list(data.entities ?? data.classes, kind === 'uml' ? '类classes' : '表entities', 1, 12).map((e, i) => {
    const field = f => {
      if (typeof f === 'string') return { text: label(f, '字段', 40) };
      const name = label(f?.name, '字段名', 24), type = optional(f?.type, '类型', 16), key = ['PK', 'FK', 'UK'].includes(f?.key) ? f.key : '';
      return { text: `${key ? key + ' ' : ''}${name}${type ? ' : ' + type : ''}`, key };
    };
    return { id: label(e?.id ?? e?.title, `第${i + 1}个id`, 40), title: label(e?.title ?? e?.id, '名称', 24), fields: list(e?.fields || [], '字段fields', 0, 20).map(field), methods: list(e?.methods || [], '方法methods', 0, 12).map(m => ({ text: label(m, '方法', 40) })) };
  });
  const byId = new Map(entities.map(e => [e.id, e]));
  const relations = list(data.relations || [], '关系relations', 0, 30).map((r, i) => {
    if (!byId.has(r?.from) || !byId.has(r?.to)) throw sceneError(`第${i + 1}条关系的from/to需为已有${kind === 'uml' ? '类' : '表'}`);
    return { from: r.from, to: r.to, label: optional(r?.label ?? r?.cardinality, '关系文字', 12), type: ['inherit', 'compose', 'depend', 'associate'].includes(r?.type) ? r.type : 'associate' };
  });
  const items = [], boxes = entities.map(e => entityBox(e, theme, kind)), cols = Math.min(3, Math.ceil(Math.sqrt(boxes.length)));
  const size = placeGrid(boxes, cols), width = Math.max(720, size.width), top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  for (const b of boxes) b.y += top;
  const box = new Map(boxes.map(b => [b.id, b]));
  // 连线：同一行走左右边，否则走上下边；拐点放在格子间的空隙里
  relations.forEach(r => {
    const a = box.get(r.from), b = box.get(r.to);
    let pts;
    if (a.row === b.row) { const [l, rr] = a.x < b.x ? [a, b] : [b, a], y1 = l.y + 30, y2 = rr.y + 30, mx = l.x + l.w + 45; pts = a === l ? [[l.x + l.w, y1], [mx, y1], [mx, y2], [rr.x, y2]] : [[rr.x, y2], [mx, y2], [mx, y1], [l.x + l.w, y1]]; }
    else { const [u, d] = a.y < b.y ? [a, b] : [b, a], my = u.y + u.h + 35, ux = u.x + u.w / 2, dx = d.x + d.w / 2; pts = a === u ? [[ux, u.y + u.h], [ux, my], [dx, my], [dx, d.y]] : [[dx, d.y], [dx, my], [ux, my], [ux, u.y + u.h]]; }
    items.push({ t: 'poly', points: pts, stroke: theme.muted, sw: 1.5, dash: r.type === 'depend' ? '5 4' : undefined, arrow: kind === 'uml' && r.type !== 'associate' ? 'end' : undefined });
    if (r.type === 'inherit' && kind === 'uml') { const [p, q] = [pts.at(-2), pts.at(-1)], d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ux = (q[0] - p[0]) / d, uy = (q[1] - p[1]) / d; items.push({ t: 'polygon', points: [q, [q[0] - ux * 14 - uy * 8, q[1] - uy * 14 + ux * 8], [q[0] - ux * 14 + uy * 8, q[1] - uy * 14 - ux * 8]], fill: theme.background, stroke: theme.muted, sw: 1.5 }); }
    if (r.label) { const m = pts[1], n = pts[2], cx = (m[0] + n[0]) / 2, cy = (m[1] + n[1]) / 2, w = textWidth(r.label, 11) + 10; items.push({ t: 'rect', x: cx - w / 2, y: cy - 9, w, h: 18, fill: theme.background }); items.push(textItem(r.label, cx, cy - 8, { size: 11, color: theme.accent, anchor: 'middle' })); }
  });
  for (const b of boxes) {
    items.push({ t: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, r: 4, fill: theme.background, stroke: theme.accent, sw: 1.5 });
    items.push({ t: 'rect', x: b.x, y: b.y, w: b.w, h: 32, r: 4, fill: theme.accent });
    items.push(textItem(b.title, b.x + 10, b.y + 7, { size: 14, weight: 700, color: '#FFFFFF', w: b.w - 20, anchor: 'middle', maxRows: 1 }));
    let y = b.y + 38;
    b.sections.forEach((sec, k) => {
      if (k) { items.push({ t: 'line', x1: b.x, y1: y - 4, x2: b.x + b.w, y2: y - 4, stroke: theme.rule }); }
      for (const f of sec) { items.push(textItem(f.text, b.x + 12, y, { size: 12, color: f.key === 'PK' ? theme.accent : theme.ink, weight: f.key === 'PK' ? 700 : 400 })); y += 20; }
      y += 10;
    });
  }
  return { width, height: top + size.height + 40, items };
}
export const erChart = (data, theme) => entityDiagram(data, theme, 'er');
export const umlChart = (data, theme) => entityDiagram(data, theme, 'uml');

export function fishboneChart(data, theme) {
  const effect = label(data.effect, '结果effect（鱼头）', 16);
  const cats = list(data.categories, '原因类别categories', 2, 6).map((c, i) => ({ title: label(c?.title, `第${i + 1}个类别`, 10), causes: list(c?.causes || [], `第${i + 1}类causes`, 1, 6).map(t => label(t, '原因', 18)) }));
  const perSide = Math.ceil(cats.length / 2), span = 230, width = 120 + perSide * span + 220, items = [], top = titleBlock(items, data.title, data.subtitle, theme, { w: width - 80 });
  const boneH = Math.max(...cats.map(c => c.causes.length)) * 26 + 60, spineY = top + boneH + 20, spineX1 = width - 210;
  items.push({ t: 'line', x1: 60, y1: spineY, x2: spineX1, y2: spineY, stroke: theme.ink, sw: 3, arrow: 'end' });
  const head = textItem(effect, spineX1 + 14, 0, { size: 15, weight: 700, color: '#FFFFFF', w: 160, maxRows: 2 });
  items.push({ t: 'rect', x: spineX1 + 4, y: spineY - head.h / 2 - 14, w: 180, h: head.h + 28, r: 6, fill: theme.accent });
  head.y = spineY - head.h / 2; items.push(head);
  cats.forEach((c, i) => {
    const up = i % 2 === 0, k = Math.floor(i / 2), bx = 100 + k * span + span * 0.75, tipX = bx - boneH * 0.55, tipY = up ? spineY - boneH : spineY + boneH;
    items.push({ t: 'line', x1: tipX, y1: tipY, x2: bx, y2: spineY, stroke: theme.ink, sw: 2 });
    items.push({ t: 'rect', x: tipX - 50, y: up ? tipY - 30 : tipY + 4, w: 100, h: 26, r: 4, fill: theme.accentTint, stroke: theme.accent });
    items.push(textItem(c.title, tipX - 50, up ? tipY - 26 : tipY + 8, { size: 13, weight: 700, color: theme.accent, w: 100, anchor: 'middle', maxRows: 1 }));
    c.causes.forEach((cause, j) => {
      const t = (j + 1) / (c.causes.length + 1), px = tipX + (bx - tipX) * t, py = tipY + (spineY - tipY) * t;
      items.push({ t: 'line', x1: px - 70, y1: py, x2: px, y2: py, stroke: theme.soft, sw: 1.2 });
      items.push(textItem(cause, px - 74, py - 9, { size: 12, color: theme.ink, anchor: 'end' }));
    });
  });
  return { width, height: spineY + boneH + 60, items };
}
export const STRUCTURE_CHARTS = { sequence: sequenceChart, er: erChart, uml: umlChart, fishbone: fishboneChart };
