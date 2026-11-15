/** 所有格式消费同一图层；SVG只由本模块编译，再经过原视觉SVG白名单。 */
import { validateVisualSceneSvg } from './visualSceneSvg.js';
import { fitDesignText, designError } from './layeredDesignInput.js';

export const DESIGN_FONT = 'Noto Sans CJK SC,Microsoft YaHei,PingFang SC,Noto Sans SC,Source Han Sans SC,Droid Sans Fallback,sans-serif';
export const designFont = family => family === 'serif' ? 'Noto Serif CJK SC,SimSun,Songti SC,Noto Serif SC,Source Han Serif SC,serif' : DESIGN_FONT;
export const escapeDesignXml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const f = n => Math.round(n * 1000) / 1000;
// 原创24×24几何图标；不从远端加载字体或第三方脚本。
const ICONS = {
  news: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7H16M8 11H16M8 15H12M8 18H16"/>',
  chart: '<path d="M3 3V21H22M7 16L12 10L16 13L21 5"/>',
  leaf: '<path d="M5 19C-1 8 10 2 21 3C22 14 16 22 5 19M4 21L17 8"/>',
  heart: '<path d="M12 21L3 12C-4 3 8 -1 12 6C16 -1 28 3 21 12Z"/>',
  star: '<path d="M12 2L15 8L22 9L17 14L18 21L12 18L6 21L7 14L2 9L9 8Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="17" rx="2"/><path d="M7 2V8M17 2V8M3 11H21M7 15H10M14 15H17M7 18H10"/>',
  cloud: '<path d="M6 19C-1 19 -1 10 6 10C7 0 22 2 21 11C27 14 23 21 18 19Z"/>',
  check: '<path d="M3 12L9 18L21 5"/>',
  arrow: '<path d="M3 12H21M14 5L21 12L14 19"/>',
  building: '<path d="M4 22V3H15V22M15 9H21V22M1 22H24M8 7H11M8 11H11M8 15H11M8 19H11M18 13H19M18 17H19"/>'
};
export function designIconMarkup(icon, color) {
  if (!ICONS[icon]) throw designError('矢量图标不存在');
  return `<g fill="none" stroke="${escapeDesignXml(color)}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>`;
}
export function chartGeometry(node) {
  const pad = Math.min(node.h * 0.2, node.w * 0.08, 40), innerW = node.w - 2 * pad;
  const innerH = node.h - pad - Math.min(64, node.h * 0.24) - 16;
  const values = node.points.map(p => p.value), low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
  return { pad, low, high, points: node.points.map((p, i) => ({ ...p, x: node.x + pad + i / (values.length - 1) * innerW, y: node.y + pad + (high - p.value) / span * innerH })) };
}
export function chartLabelNodes(node) {
  const size = Math.max(12, Math.min(26, node.h * 0.09)), h = Math.min(64, node.h * 0.24);
  return [node.points[0], node.points.at(-1)].map((p, i) => ({
    id: node.id + '-label-' + i, type: 'text', text: p.label, fontSize: size, minFontSize: 12, weight: 400, color: node.color,
    x: i ? node.x + node.w * 0.55 : node.x, y: node.y + node.h - h, w: node.w * 0.45, h, align: i ? 'right' : 'left'
  }));
}
export function designLayerMarkup(node, assets, font = DESIGN_FONT) {
  const { x, y, w, h } = node, esc = escapeDesignXml;
  if (node.type === 'shape') return `<rect x="${x}" y="${y}" width="${w}" height="${h}"${node.radius ? ` rx="${node.radius}"` : ''} fill="${node.fill}"${node.stroke ? ` stroke="${node.stroke}"` : ''}/>`;
  if (node.type === 'icon') return `<g transform="translate(${x} ${y}) scale(${f(w / 24)} ${f(h / 24)})">${designIconMarkup(node.icon, node.color)}</g>`;
  if (node.type === 'image') {
    const asset = assets.get(node.asset);
    if (!asset) throw designError(`图层${node.id}引用的素材不存在`);
    return `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${node.fit === 'contain' ? 'meet' : 'slice'}" href="${asset.data}"/>`;
  }
  if (node.type === 'text') {
    const fitted = fitDesignText(node), tx = node.align === 'center' ? x + w / 2 : node.align === 'right' ? x + w : x;
    const anchor = node.align === 'center' ? 'middle' : node.align === 'right' ? 'end' : 'start';
    // 每行独立真实文字，不使用textLength压扁中文；实际字体/字形在导出时核验。
    return fitted.rows.map((row, i) => `<text x="${f(tx)}" y="${f(y + fitted.fontSize * 1.08 + i * fitted.lineHeight)}" font-family="${font}" font-size="${f(fitted.fontSize)}" font-weight="${node.weight}" fill="${node.color}" text-anchor="${anchor}" xml:space="preserve">${esc(row)}</text>`).join('');
  }
  const geometry = chartGeometry(node);
  const path = geometry.points.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join('');
  return `<path d="${path}" fill="none" stroke="${node.color}" stroke-width="${f(Math.max(2, w / 450))}"/>` + geometry.points.map(p => `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(Math.max(3, w / 280))}" fill="${node.color}"/>`).join('') +
    chartLabelNodes(node).map(label => designLayerMarkup(label, assets, font)).join('');
}
export function composeLayeredSvg(design, assets = new Map()) {
  const { width, height, palette } = design;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="${width}" height="${height}" fill="${palette.background}"/>` +
    design.layers.map(node => `<g id="layer-${node.id}">${designLayerMarkup(node, assets, designFont(design.fontFamily))}</g>`).join('') + '</svg>';
  return validateVisualSceneSvg(svg).svg;
}
