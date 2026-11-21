/**
 * 设计规则体检（2026-11-17 用户讨论 Demo“做得美观大方”）：程序负责“不乱”，模型负责“好看”。
 *
 * 只给建议，不改稿、不判失败：
 *   - 颜色：画面里用到的颜色是否太多、是否偏离调色板；
 *   - 对齐：左对齐文字的起始线是否太多（看起来散）；
 *   - 字号：字号级别是否太多（层次乱）；
 *   - 主图主色：从主图实际像素取 3 个主色，强调色离主图太远时建议从主图取色，让图和字一个调子。
 */
import { decodePngRgba } from './posterContrast.js';
import { DESIGN_FONT } from './layeredDesignSvg.js';
import { throwControl } from '../core/networkRequest.js';

const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const rgb = value => { const v = String(value).replace('#', ''); return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16)); };
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

/** 把主图缩成小图，用真实渲染器读像素，粗分 3 个主色（按占比排序） */
export async function imageColors(asset, raster, signal) {
  if (!asset?.data) return [];
  // 渲染器要求矢量图里有文字，放一个全透明的字，不影响像素
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid slice" href="${asset.data}"/><g opacity="0"><text x="2" y="20" font-family="${DESIGN_FONT}" font-size="12" fill="#000000">色</text></g></svg>`;
  const rendered = await raster(svg, { signal });
  throwControl(null, signal);
  const image = await decodePngRgba(new Uint8Array(await rendered.blob.arrayBuffer()));
  if (!image) return [];
  // 每通道分 4 档做直方图，取最多的 3 档的平均色；相近的合并
  const bins = new Map();
  for (let i = 0; i < image.data.length; i += 4) {
    const key = (image.data[i] >> 6) * 16 + (image.data[i + 1] >> 6) * 4 + (image.data[i + 2] >> 6);
    const bin = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += image.data[i]; bin.g += image.data[i + 1]; bin.b += image.data[i + 2];
    bins.set(key, bin);
  }
  const total = image.data.length / 4, colors = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    const color = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
    if (colors.some(c => distance(c.rgb, color) < 60)) continue;
    colors.push({ rgb: color, share: bin.n / total });
    if (colors.length === 3) break;
  }
  return colors.map(c => ({ color: hex(...c.rgb), share: Math.round(c.share * 100) / 100 }));
}

export function lintLayerDesign(design, colors = []) {
  const suggestions = [];
  const visible = design.layers.filter(n => !n.decorative);
  const texts = visible.filter(n => n.type === 'text' && n.text.trim());
  const paletteColors = Object.values(design.palette).map(c => String(c).toUpperCase());
  const used = new Set([...texts.map(n => n.color), ...visible.filter(n => n.type === 'shape').map(n => n.fill)].map(c => String(c).toUpperCase()));
  const offPalette = [...used].filter(c => !paletteColors.includes(c));
  if (used.size > 6 || offPalette.length > 3)
    suggestions.push({ code: 'DESIGN_TOO_MANY_COLORS', message: `画面用了${used.size}种文字/色块颜色，其中${offPalette.length}种不在调色板里；建议收到调色板的4–5个颜色内，同类内容同色`, colors: offPalette.slice(0, 8) });
  const edges = [];
  for (const x of texts.filter(n => (n.align || 'left') === 'left').map(n => n.x).sort((a, b) => a - b)) if (!edges.length || x - edges.at(-1) > 6) edges.push(x);
  if (edges.length > 4) suggestions.push({ code: 'DESIGN_TOO_MANY_EDGES', message: `左对齐文字有${edges.length}条起始线，看起来散；建议收成2–3条（如统一页边距、分栏线）`, edges: edges.slice(0, 8).map(Math.round) });
  const sizes = [...new Set(texts.map(n => Math.round(n.fontSize / 2) * 2))];
  if (sizes.length > 6) suggestions.push({ code: 'DESIGN_TOO_MANY_SIZES', message: `字号有${sizes.length}级，层次乱；建议收敛到4–5级（标题/副题/正文/注释）`, sizes: sizes.sort((a, b) => b - a) });
  if (colors.length && design.palette.accent) {
    const accent = rgb(design.palette.accent), nearest = Math.min(...colors.map(c => distance(rgb(c.color), accent)));
    if (nearest > 150) suggestions.push({ code: 'DESIGN_ACCENT_OFF_IMAGE', message: `强调色${design.palette.accent}和主图色调差得远；可从主图主色里取（${colors.map(c => c.color).join('、')}），让图和字一个调子` });
  }
  return { status: suggestions.length ? 'advice' : 'clean', suggestions, ...(colors.length && { imageColors: colors }), basis: '程序按图层数据检查颜色、对齐线、字号层级和主图主色，只给建议，不判失败' };
}
