/**
 * 图表/图示共用的“图元”底层（2026-11-17 用户：他的50种图我们全部做）。
 *
 * 每种图只负责把数据排成图元（矩形、椭圆、线、折线、多边形、文字），这里统一：
 *   - 导出 SVG（经视觉 SVG 白名单校验，再由同一渲染器转 PNG）；
 *   - 导出原生可编辑 PPTX（矩形/椭圆/线/文字是 PowerPoint 自带对象，多边形用自定义形状，都能直接改）；
 *   - 文字按真实字宽换行，放不下就报错，不截字。
 * 坐标单位为像素，原点左上角。
 */
import { wrapParagraphs } from './posterComposition.js';
import { DESIGN_FONT, escapeDesignXml as esc } from './layeredDesignSvg.js';
import { validateVisualSceneSvg } from './visualSceneSvg.js';

export const sceneError = (message, code = 'CHART_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });
export const round = n => Math.round(n * 10) / 10;

/** 配色：中性底 + 一个强调色；分类色按色相拉开，深浅一致，色弱也能分辨主次 */
export const CHART_THEMES = {
  blue: { background: '#FFFFFF', ink: '#1F2A37', muted: '#5B6B7F', soft: '#94A3B8', rule: '#E2E8F0', panel: '#F6F8FB', accent: '#2563EB', accentTint: '#DBEAFE', good: '#16A34A', bad: '#DC2626',
    series: ['#2563EB', '#F59E0B', '#10B981', '#8B5CF6', '#EF4444', '#06B6D4', '#84CC16', '#EC4899'] },
  gray: { background: '#FFFFFF', ink: '#222222', muted: '#555555', soft: '#999999', rule: '#E5E5E5', panel: '#F7F7F7', accent: '#111111', accentTint: '#E5E7EB', good: '#15803D', bad: '#B91C1C',
    series: ['#374151', '#9CA3AF', '#6B7280', '#D1D5DB', '#1F2937', '#4B5563', '#E5E7EB', '#111827'] },
  green: { background: '#FFFFFF', ink: '#1C2B22', muted: '#4B6356', soft: '#94A89C', rule: '#E2ECE6', panel: '#F5FAF7', accent: '#15803D', accentTint: '#DCFCE7', good: '#15803D', bad: '#DC2626',
    series: ['#15803D', '#CA8A04', '#0E7490', '#7C3AED', '#DC2626', '#65A30D', '#DB2777', '#0891B2'] }
};
export const themeOf = name => CHART_THEMES[name] || CHART_THEMES.blue;

/** 按真实字宽换行；width 给定时超出 maxRows 行就报错 */
export function wrapText(text, size, width, { maxRows = 6, what = '文字' } = {}) {
  const value = String(text ?? '');
  if (!width) return [value];
  const rows = wrapParagraphs(value, size, width) || null;
  if (!rows || rows.length > maxRows) throw sceneError(`${what}“${value.slice(0, 12)}…”在可用宽度内放不下，请精简文字（不自动截字）`, 'CHART_TEXT_OVERFLOW');
  return rows;
}
export const textWidth = (text, size) => [...String(text)].reduce((s, c) => s + (/[\x20-\x7e]/.test(c) ? 0.56 : 1), 0) * size;

function svgOf(item) {
  const stroke = item.stroke ? ` stroke="${item.stroke}" stroke-width="${item.sw ?? 1}"${item.dash ? ` stroke-dasharray="${item.dash}"` : ''}` : '';
  const fill = item.fill ? ` fill="${item.fill}"${item.opacity !== undefined ? ` fill-opacity="${item.opacity}"` : ''}` : ' fill="none"';
  switch (item.t) {
    case 'rect': return `<rect x="${round(item.x)}" y="${round(item.y)}" width="${round(item.w)}" height="${round(item.h)}"${item.r ? ` rx="${item.r}"` : ''}${fill}${stroke}/>`;
    case 'ellipse': return `<ellipse cx="${round(item.cx)}" cy="${round(item.cy)}" rx="${round(item.rx)}" ry="${round(item.ry)}"${fill}${stroke}/>`;
    case 'line': return `<line x1="${round(item.x1)}" y1="${round(item.y1)}" x2="${round(item.x2)}" y2="${round(item.y2)}"${stroke || ' stroke="#000000"'}/>` + arrows(item, [[item.x1, item.y1], [item.x2, item.y2]]);
    case 'poly': return `<polyline points="${item.points.map(p => p.map(round).join(',')).join(' ')}" fill="none"${stroke}/>` + arrows(item, item.points);
    case 'polygon': return `<polygon points="${item.points.map(p => p.map(round).join(',')).join(' ')}"${fill}${stroke}/>`;
    case 'text': {
      const anchor = item.anchor || 'start', x = anchor === 'middle' ? item.x + (item.w || 0) / 2 : anchor === 'end' ? item.x + (item.w || 0) : item.x;
      return item.rows.map((row, i) => `<text x="${round(x)}" y="${round(item.y + item.size * 1.05 + i * item.size * 1.4)}" font-family="${DESIGN_FONT}" font-size="${item.size}" font-weight="${item.weight || 400}" fill="${item.color}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''} xml:space="preserve">${esc(row)}</text>`).join('');
    }
    default: throw sceneError('未知图元');
  }
}
function arrowHead([px, py], [x, y], color) {
  const len = 9, half = 4.5, dx = x - px, dy = y - py, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, bx = x - ux * len, by = y - uy * len;
  return `<polygon points="${round(x)},${round(y)} ${round(bx - uy * half)},${round(by + ux * half)} ${round(bx + uy * half)},${round(by - ux * half)}" fill="${color}"/>`;
}
function arrows(item, pts) {
  let out = '';
  if (item.arrow === 'end' || item.arrow === 'both') out += arrowHead(pts.at(-2), pts.at(-1), item.stroke);
  if (item.arrow === 'both' || item.arrow === 'start') out += arrowHead(pts[1], pts[0], item.stroke);
  return out;
}

/** 文字图元：给 w 时自动换行并记录行数，返回它占的高度 */
export function textItem(text, x, y, { size = 14, w, color, weight, anchor, maxRows, what } = {}) {
  const rows = w ? wrapText(text, size, w, { maxRows, what }) : [String(text)];
  return { t: 'text', x, y, w, rows, size, color, weight, anchor, h: rows.length * size * 1.4 };
}

export function sceneScale(width, height) {
  const longest = Math.max(width, height);
  if (longest > 4096) throw sceneError('图太大（最长边超过4096像素），请拆成几张图', 'CHART_TOO_LARGE');
  return Math.max(1, Math.min(2, Math.floor((4096 / longest) * 100) / 100));
}
export function composeSceneSvg(scene) {
  const width = Math.ceil(scene.width), height = Math.ceil(scene.height), scale = sceneScale(width, height);
  const W = Math.round(width * scale), H = Math.round(height * scale);
  const body = [`<rect x="0" y="0" width="${width}" height="${height}" fill="${scene.background}"/>`, ...scene.items.map(svgOf)].join('');
  return validateVisualSceneSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g transform="scale(${scale})">${body}</g></svg>`).svg;
}

/** 原生可编辑 PPTX：每个图元一个 PowerPoint 对象 */
export async function composeScenePptx(scene) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS(), inch = px => px / 96, c = v => String(v).replace('#', '');
  pptx.defineLayout({ name: 'CHART', width: inch(scene.width), height: inch(scene.height) });
  pptx.layout = 'CHART'; pptx.title = scene.title; pptx.author = '未央'; pptx.lang = 'zh-CN';
  const slide = pptx.addSlide();
  slide.background = { color: c(scene.background) };
  const font = 'Noto Sans CJK SC';
  const line = item => ({ color: c(item.stroke || '#000000'), width: (item.sw ?? 1) * 0.75, ...(item.dash && { dashType: 'dash' }) });
  const fill = item => (item.fill ? { color: c(item.fill), ...(item.opacity !== undefined && { transparency: Math.round((1 - item.opacity) * 100) }) } : { type: 'none' });
  const segment = (a, b, item, arrow) => slide.addShape(pptx.ShapeType.line, { x: inch(Math.min(a[0], b[0])), y: inch(Math.min(a[1], b[1])), w: inch(Math.abs(b[0] - a[0])), h: inch(Math.abs(b[1] - a[1])),
    flipH: b[0] < a[0], flipV: b[1] < a[1], line: { ...line(item), ...(arrow && { endArrowType: 'triangle' }) } });
  for (const item of scene.items) {
    if (item.t === 'rect') slide.addShape(item.r ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { x: inch(item.x), y: inch(item.y), w: inch(Math.max(item.w, 0.5)), h: inch(Math.max(item.h, 0.5)), fill: fill(item), line: item.stroke ? line(item) : { type: 'none' }, ...(item.r && { rectRadius: inch(item.r) }) });
    else if (item.t === 'ellipse') slide.addShape(pptx.ShapeType.ellipse, { x: inch(item.cx - item.rx), y: inch(item.cy - item.ry), w: inch(item.rx * 2), h: inch(item.ry * 2), fill: fill(item), line: item.stroke ? line(item) : { type: 'none' } });
    else if (item.t === 'line') segment([item.x1, item.y1], [item.x2, item.y2], item, item.arrow === 'end' || item.arrow === 'both');
    else if (item.t === 'poly') item.points.slice(1).forEach((p, k) => segment(item.points[k], p, item, k === item.points.length - 2 && (item.arrow === 'end' || item.arrow === 'both')));
    else if (item.t === 'polygon') {
      const xs = item.points.map(p => p[0]), ys = item.points.map(p => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
      slide.addShape(pptx.ShapeType.custGeom, { x: inch(x0), y: inch(y0), w: inch(Math.max(1, Math.max(...xs) - x0)), h: inch(Math.max(1, Math.max(...ys) - y0)), fill: fill(item), line: item.stroke ? line(item) : { type: 'none' },
        points: [...item.points.map(([x, y], i) => ({ x: inch(x - x0), y: inch(y - y0), ...(i === 0 && { moveTo: true }) })), { close: true }] });
    } else if (item.t === 'text') {
      const width = item.w || Math.max(...item.rows.map(r => textWidth(r, item.size))) + 4;
      const x = item.w ? item.x : item.anchor === 'middle' ? item.x - width / 2 : item.anchor === 'end' ? item.x - width : item.x;
      slide.addText(item.rows.join('\n'), { x: inch(x), y: inch(item.y), w: inch(width), h: inch(item.rows.length * item.size * 1.4 + 2), fontSize: item.size * 0.75, fontFace: font, bold: (item.weight || 400) >= 600,
        color: c(item.color), align: item.anchor === 'middle' ? 'center' : item.anchor === 'end' ? 'right' : 'left', valign: 'top', margin: 0, paraSpaceAfterPt: 0, lineSpacingMultiple: 1.1 });
    }
  }
  return pptx.write({ outputType: 'blob' });
}

/** 标题 + 可选副标题，返回内容区起点 */
export function titleBlock(items, title, subtitle, theme, { x = 40, y = 32, w } = {}) {
  const t = textItem(title, x, y, { size: 26, weight: 700, color: theme.ink, w, maxRows: 2, what: '标题' });
  items.push(t);
  let bottom = y + t.h;
  if (subtitle) { const s = textItem(subtitle, x, bottom + 6, { size: 14, color: theme.muted, w, maxRows: 3, what: '副标题' }); items.push(s); bottom += 6 + s.h; }
  return bottom + 24;
}
/** 图例：水平一条放在底部（借鉴 diagram-design：图例不浮在图中间） */
export function legendStrip(items, entries, x, y, theme) {
  let cx = x;
  for (const { label, color, dash } of entries) {
    if (dash) items.push({ t: 'line', x1: cx, y1: y + 8, x2: cx + 18, y2: y + 8, stroke: color, sw: 2, dash: '5 4' });
    else items.push({ t: 'rect', x: cx, y: y + 2, w: 14, h: 12, r: 2, fill: color });
    items.push(textItem(label, cx + 22, y - 1, { size: 12, color: theme.muted }));
    cx += 22 + textWidth(label, 12) + 22;
  }
  return y + 24;
}

/** 数轴刻度：取 4–6 个“整”刻度 */
export function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min, step0 = span / count, mag = 10 ** Math.floor(Math.log10(step0)), norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
export const fmt = (v, unit = '') => `${Number.isInteger(v) ? v : Math.round(v * 100) / 100}${unit}`;
