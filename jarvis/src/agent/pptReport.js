/**
 * 政企汇报风格的画法（用户 2026-11-05 给的参考：运营商政企项目汇报稿）。只借鉴版式思路，不用任何单位的标志和品牌。
 *   页框：左上“二、章节：小标题”（章节主色、小标题副色），右上单位名称；标题下一句居中结论，**关键词**标红、数字标蓝
 *   封面 / 章节 / 结尾：整页原生渐变（pptGradient.js）加半透明大圆；“打印友好”时改白底
 *   内容：指标条、痛点四宫格、编号四宫格、三栏面板、竖标签面板、左图右文（图下说明条）、目录
 * 由 pptxWriter.js 调用；坐标单位英寸，16:9 宽屏 13.333 × 7.5。
 */
import { gradientName } from './pptGradient.js';

export const W = 13.333;
export const H = 7.5;
const CN = '一二三四五六七八九十';
/** 页标题“二、AI解决方案：1.预警端智能”拆成章节和小标题 */
export function splitReportTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/^([一二三四五六七八九十]{1,3}、[^：:]{1,20}[：:])\s*(.+)$/);
  if (m) return { lead: m[1], rest: m[2], section: m[1].replace(/^[一二三四五六七八九十]{1,3}、|[：:]$/g, '') };
  const s = t.match(/^([一二三四五六七八九十]{1,3})、(.{1,24})$/);
  return s ? { lead: t, rest: '', section: s[2] } : { lead: '', rest: t, section: '' };
}
export const cnNumber = (k) => (k < 10 ? CN[k] : String(k + 1));

/** 页内第一段“结论：……”“核心观点：……”：放到标题下面那一行 */
export const KEY_LINE = /^(?:结论|核心观点|一句话|本页结论|要点)\s*[：:]\s*(.{4,90})$/;

/** 文字 → 带颜色的片段：**加粗**标红，数字（含单位）标蓝加粗 */
const NUMBER = /([近约超逾]?\d[\d,.]*\s*(?:%|万亿元|亿元|万元|万|亿|千|余|个|项|类|人|次|倍|秒|毫秒|分钟|小时|天|公里|km|平方公里|吨|家|台|套|座|处)?\+?)/g;
export function richRuns(inlines, { color, hot, num, size, bold = false }) {
  const runs = [];
  for (const r of inlines) {
    const text = String(r.text ?? '');
    if (!text) continue;
    if (r.bold) { runs.push({ text, options: { bold: true, color: hot, ...(size && { fontSize: size }) } }); continue; }
    let last = 0;
    for (const m of text.matchAll(NUMBER)) {
      if (!/\d/.test(m[0])) continue;
      if (m.index > last) runs.push({ text: text.slice(last, m.index), options: { color, bold, ...(size && { fontSize: size }) } });
      runs.push({ text: m[0], options: { color: num, bold: true, ...(size && { fontSize: size }) } });
      last = m.index + m[0].length;
    }
    if (last < text.length) runs.push({ text: text.slice(last), options: { color, bold, ...(size && { fontSize: size }) } });
  }
  return runs.length ? runs : [{ text: '', options: {} }];
}
/** 纯文字的“**关键**”写法 → 片段 */
export const inlinesOf = (text) => String(text ?? '').split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(t => (/^\*\*[^*]+\*\*$/.test(t) ? { text: t.slice(2, -2), bold: true } : { text: t }));

/** 渐变整页底：打印友好时改白底 */
function gradientPage(sl, pptx, T, { soft = false, print = false } = {}) {
  if (print) { sl.background = { color: 'FFFFFF' }; return false; }
  const colors = soft ? T.gradientSoft : T.gradient;
  sl.background = { color: colors[0] };
  sl.addShape(pptx.ShapeType.rect, { objectName: gradientName(colors, 35), x: 0, y: 0, w: W, h: H, fill: { color: colors[1] }, line: { color: colors[1] } });
  const ring = (x, y, d, t) => sl.addShape(pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: 'FFFFFF', transparency: t }, line: { color: 'FFFFFF', transparency: 100 } });
  ring(-1.2, 3.9, 4.4, 92); ring(W - 3.4, 4.6, 3.6, 90); ring(W - 2.0, -0.9, 2.6, 94);
  return true;
}

export function reportCover(sl, ctx, { title, subtitle, author, date, print }) {
  const { pptx, T, FONT, HFONT } = ctx;
  const dark = gradientPage(sl, pptx, T, { print });
  const fg = dark ? 'FFFFFF' : T.head, sub = dark ? 'E3EEFC' : T.sub;
  if (author) sl.addText(author, { x: 0.9, y: 0.7, w: W - 1.8, h: 0.45, fontSize: 15, bold: true, color: sub, fontFace: FONT, margin: 0 });
  sl.addText(title, { x: 0.9, y: 2.0, w: W - 1.8, h: 1.9, fontSize: 42, bold: true, color: fg, fontFace: HFONT, valign: 'bottom', fit: 'shrink', margin: 0 });
  sl.addShape(pptx.ShapeType.rect, { x: 0.92, y: 4.15, w: 1.2, h: 0.06, fill: { color: dark ? 'FFFFFF' : T.accent }, line: { color: dark ? 'FFFFFF' : T.accent } });
  if (subtitle) sl.addText(subtitle, { x: 0.9, y: 4.4, w: W - 1.8, h: 1.0, fontSize: 20, color: sub, fontFace: FONT, valign: 'top', fit: 'shrink', margin: 0 });
  if (date) sl.addText(date, { objectName: 'wy-cover-meta', x: 0.9, y: H - 1.15, w: 6, h: 0.45, fontSize: 14, color: sub, fontFace: FONT, margin: 0 });
}

export function reportSection(sl, ctx, { mark, title, lines, print }) {
  const { pptx, T, FONT, HFONT } = ctx;
  const dark = gradientPage(sl, pptx, T, { soft: true, print });
  const fg = dark ? 'FFFFFF' : T.head;
  sl.addText(mark, { x: 0.9, y: 1.5, w: 4, h: 1.7, fontSize: 88, bold: true, color: dark ? 'FFFFFF' : T.accent, transparency: dark ? 25 : 0, fontFace: FONT, valign: 'bottom', margin: 0 });
  sl.addText(title, { x: 0.9, y: 3.35, w: W - 1.8, h: 1.3, fontSize: 38, bold: true, color: fg, fontFace: HFONT, valign: 'top', fit: 'shrink', margin: 0 });
  if (lines.length) sl.addText(lines.join('　'), { x: 0.9, y: 4.75, w: W - 1.8, h: 0.9, fontSize: 18, color: dark ? 'E3EEFC' : T.sub, fontFace: FONT, valign: 'top', fit: 'shrink', margin: 0 });
}

export function reportEnd(sl, ctx, { words, lines, author, print }) {
  const { pptx, T, FONT, HFONT } = ctx;
  const dark = gradientPage(sl, pptx, T, { print });
  const fg = dark ? 'FFFFFF' : T.head;
  const slogan = lines[0] || '';
  if (slogan) sl.addText(inlinesOf(slogan).map(r => ({ text: r.text, options: { bold: true, color: fg } })), { x: 1.0, y: 1.9, w: W - 2.0, h: 1.3, fontSize: 34, fontFace: HFONT, align: 'center', valign: 'bottom', fit: 'shrink' });
  if (lines[1]) sl.addText(lines.slice(1).join('　'), { x: 1.5, y: 3.3, w: W - 3.0, h: 0.6, fontSize: 15, color: dark ? 'E3EEFC' : T.sub, fontFace: FONT, align: 'center', fit: 'shrink' });
  sl.addShape(pptx.ShapeType.rect, { x: W / 2 - 0.6, y: 4.15, w: 1.2, h: 0.05, fill: { color: dark ? 'FFFFFF' : T.accent }, line: { color: dark ? 'FFFFFF' : T.accent } });
  sl.addText(words, { x: 1.5, y: 4.4, w: W - 3.0, h: 0.9, fontSize: slogan ? 28 : 44, bold: true, color: fg, fontFace: HFONT, align: 'center', valign: 'middle', charSpacing: 4, fit: 'shrink' });
  if (author) sl.addText(author, { x: 1.5, y: H - 1.1, w: W - 3.0, h: 0.4, fontSize: 14, color: dark ? 'E3EEFC' : T.muted, fontFace: FONT, align: 'center' });
}

/** 页框：章节 + 小标题两种颜色；右上单位；标题下一句结论 */
export function reportHeader(sl, ctx, { title, unit, key, section }) {
  const { T, FONT, HFONT } = ctx;
  sl.background = { color: 'FFFFFF' };
  const parts = splitReportTitle(title);
  const lead = parts.lead || (section && parts.rest ? `${section}：` : '');
  const runs = [
    ...(lead ? [{ text: lead, options: { color: T.head, bold: true } }] : []),
    ...(parts.rest ? [{ text: parts.rest, options: { color: lead ? T.subtitle : T.head, bold: true } }] : [])
  ];
  sl.addText(runs, { objectName: 'wy-title', x: 0.6, y: 0.28, w: W - (unit ? 3.6 : 1.2), h: 0.62, fontSize: T.titleSize, fontFace: HFONT, valign: 'middle', fit: 'shrink', margin: 0 });
  if (unit) sl.addText(unit, { x: W - 2.95, y: 0.3, w: 2.35, h: 0.55, fontSize: 14, bold: true, color: T.head, fontFace: FONT, align: 'right', valign: 'middle', fit: 'shrink', margin: 0 });
  if (key) sl.addText(richRuns(inlinesOf(key), { color: T.head, hot: T.hot, num: T.hot, bold: true }), { objectName: 'wy-key', x: 0.6, y: 0.95, w: W - 1.2, h: 0.5, fontSize: 16, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
}

export function reportPageNo(sl, ctx, n) {
  sl.addText(String(n), { x: ctx.W - 1.0, y: ctx.H - 0.42, w: 0.5, h: 0.28, fontSize: 10, color: ctx.T.muted, align: 'right', fontFace: ctx.FONT, valign: 'middle' });
}

/** 目录：01 / 02 / 03 大号数字 + 标题 + 灰色说明 */
export function reportAgenda(sl, ctx, rows) {
  const { pptx, T, FONT } = ctx;
  const n = Math.min(rows.length, 6), gap = 0.22;
  const h = Math.min(1.25, (5.3 - gap * (n - 1)) / n);
  const top = 1.7 + (5.2 - (n * h + (n - 1) * gap)) / 2;
  rows.slice(0, n).forEach((r, k) => {
    const y = top + k * (h + gap), x = 1.4, w = W - 2.8;
    sl.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: T.panel }, line: { color: T.panel } });
    sl.addText(String(k + 1).padStart(2, '0'), { x: x + 0.35, y, w: 1.3, h, fontSize: 32, bold: true, color: T.accent, fontFace: FONT, valign: 'middle', margin: 0 });
    sl.addText(r.title, { x: x + 1.8, y: y + (r.sub ? h * 0.12 : 0), w: w - 2.2, h: r.sub ? h * 0.5 : h, fontSize: 20, bold: true, color: T.text, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
    if (r.sub) sl.addText(r.sub, { x: x + 1.8, y: y + h * 0.58, w: w - 2.2, h: h * 0.34, fontSize: 12, color: T.muted, fontFace: FONT, align: 'center', valign: 'top', fit: 'shrink', margin: 0 });
  });
}

/** 指标条：浅色渐变块里大号数字 + 小字说明；一行最多 4 个 */
export function reportKpis(sl, ctx, items, { top = 1.75, bottom = 6.85 } = {}) {
  const { pptx, T, FONT } = ctx;
  const cols = items.length <= 4 ? items.length : 3, rows = Math.ceil(items.length / cols), gap = 0.3;
  const cw = (W - 1.2 - gap * (cols - 1)) / cols;
  const ch = Math.min(rows === 1 ? 3.8 : 2.4, (bottom - top - gap * (rows - 1)) / rows);
  const y0 = top + (bottom - top - (rows * ch + (rows - 1) * gap)) / 2;
  items.forEach((m, k) => {
    const x = 0.6 + (k % cols) * (cw + gap), y = y0 + Math.floor(k / cols) * (ch + gap);
    const light = [T.soft, 'F8FBFF'];
    sl.addShape(pptx.ShapeType.rect, { objectName: gradientName(light, 90), x, y, w: cw, h: ch, fill: { color: T.soft }, line: { color: T.soft } });
    sl.addText(m.num, { x: x + 0.2, y: y + ch * 0.12, w: cw - 0.4, h: ch * 0.5, fontSize: rows === 1 ? 46 : 34, bold: true, color: T.head, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
    sl.addText(m.label, { x: x + 0.3, y: y + ch * 0.62, w: cw - 0.6, h: ch * 0.3, fontSize: 17, color: T.sub, fontFace: FONT, align: 'center', valign: 'top', fit: 'shrink', margin: 0 });
  });
  return items.length ? 1 : 0;
}

/** 说明里用“｜”隔开时：前半句是红色小标题（如“前端布点少，回传难｜重点水域地处偏远……”） */
const splitSub = (text) => { const i = String(text).search(/[｜|]/); return i > 0 && i <= 24 ? { sub: text.slice(0, i).trim(), desc: text.slice(i + 1).trim() } : { sub: '', desc: text }; };

/** 卡片三种画法：pain 痛点（图标 + 标题 + 红色小标题 + 说明）、numbered 编号胶囊、columns 三栏面板 */
export function reportCards(sl, ctx, its, variant, { top: top0 = 1.7, bottom = 6.85 } = {}) {
  let top = top0;
  const { pptx, T, FONT, iconCircle, pick } = ctx;
  const n = its.length;
  const cols = variant === 'columns' ? n : n === 4 ? 2 : n <= 3 ? n : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols), gap = 0.3;
  const w = (W - 1.2 - gap * (cols - 1)) / cols;
  let h = (bottom - top - gap * (rows - 1)) / rows;
  // 只有一行时不拉满整页：收矮到 4 寸、上下居中，下面不留一大片空
  if (rows === 1 && h > 4.6) { top += (h - 4.6) / 2; h = 4.6; }
  its.forEach((it, k) => {
    const x = 0.6 + (k % cols) * (w + gap), y = top + Math.floor(k / cols) * (h + gap);
    const { sub, desc } = splitSub(it.text);
    const body = (dx, dy, dw, dh, size = 16) => sl.addText(richRuns(inlinesOf(desc), { color: T.sub, hot: T.hot, num: T.accent, size }), { x: dx, y: dy, w: dw, h: dh, fontSize: size, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.3, fit: 'shrink', margin: 0 });
    if (variant === 'columns') {
      sl.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: T.panel }, line: { color: T.border, width: 0.75 } });
      sl.addShape(pptx.ShapeType.rect, { x: x + 0.25, y: y + 0.25, w: w - 0.5, h: 0.62, fill: { color: T.soft }, line: { color: T.soft } });
      sl.addText(it.label, { x: x + 0.25, y: y + 0.25, w: w - 0.5, h: 0.62, fontSize: 18, bold: true, color: T.accent, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
      if (sub) sl.addText(sub, { x: x + 0.35, y: y + 1.05, w: w - 0.7, h: 0.45, fontSize: 14, bold: true, color: T.hot, fontFace: FONT, fit: 'shrink', margin: 0 });
      body(x + 0.35, y + (sub ? 1.55 : 1.15), w - 0.7, h - (sub ? 1.75 : 1.35), 17);
      return;
    }
    sl.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: T.panel }, line: { color: T.border, width: 0.75 } });
    if (variant === 'numbered') {
      sl.addShape(pptx.ShapeType.ellipse, { x: x + 0.3, y: y + 0.3, w: 0.52, h: 0.52, fill: { color: T.accent }, line: { color: T.accent } });
      sl.addText(String(k + 1), { x: x + 0.3, y: y + 0.3, w: 0.52, h: 0.52, fontSize: 16, bold: true, color: 'FFFFFF', fontFace: FONT, align: 'center', valign: 'middle', margin: 0 });
      sl.addShape(pptx.ShapeType.roundRect, { x: x + 1.0, y: y + 0.28, w: w - 1.3, h: 0.56, fill: { color: T.soft }, line: { color: T.soft }, rectRadius: 0.28 });
      sl.addText(it.label, { x: x + 1.15, y: y + 0.28, w: w - 1.6, h: 0.56, fontSize: 16, bold: true, color: T.head, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
      if (sub) sl.addText(sub, { x: x + 0.35, y: y + 1.0, w: w - 0.7, h: 0.4, fontSize: 14, bold: true, color: T.hot, fontFace: FONT, fit: 'shrink', margin: 0 });
      body(x + 0.35, y + (sub ? 1.45 : 1.05), w - 0.7, h - (sub ? 1.6 : 1.2));
      return;
    }
    iconCircle(sl, x + 0.3, y + 0.3, 0.62, pick(`${it.label} ${it.text}`), T.accent, k);
    sl.addText(it.label, { x: x + 1.1, y: y + 0.28, w: w - 1.4, h: 0.4, fontSize: 18, bold: true, color: T.accent, fontFace: FONT, valign: 'middle', fit: 'shrink', margin: 0 });
    if (sub) sl.addText(sub, { x: x + 1.1, y: y + 0.68, w: w - 1.4, h: 0.32, fontSize: 14, bold: true, color: T.hot, fontFace: FONT, valign: 'middle', fit: 'shrink', margin: 0 });
    body(x + 0.35, y + 1.15, w - 0.7, h - 1.3);
  });
}
