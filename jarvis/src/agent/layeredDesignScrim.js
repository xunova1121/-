/**
 * 叠加版式：文字直接压在照片上时的局部遮罩（2026-11-17 用户：海报不能只是上图下文，有可能是叠加的）。
 *
 * 只在“按真实像素量出来看不清”时才加：先把成品去掉文字渲染一遍，逐行量文字背后的对比度；
 * 压在图片上、且不达标的文字，在它背后加一条横贯图片的渐变遮罩（上下两端透明，中间加深），
 * 再量一次，不够就加深一档，最多三档。量出来本来就清楚的（照片暗处、模型自己垫了底块）一律不加。
 * 不改原文、字号、位置、画幅和素材；遮罩是装饰图层，写进源稿，下次改字时沿用。
 */
import { fitDesignText } from './layeredDesignInput.js';
import { decodePngRgba, luminanceHex, measureTextContrast, withoutText } from './posterContrast.js';
import { throwControl } from '../core/networkRequest.js';

export const SCRIM_LEVELS = [0.5, 0.66, 0.8];
const round = n => Math.round(n * 1000) / 1000;
const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** 文字实际占的行（不是模型给的大框），与对比度检查用同一算法 */
function textRows(node) {
  const fitted = fitDesignText(node);
  return fitted.rows.filter(Boolean).map((row, i) => {
    const w = Math.min(node.w, [...row].length * fitted.fontSize), x = node.align === 'center' ? node.x + (node.w - w) / 2 : node.align === 'right' ? node.x + node.w - w : node.x;
    return { role: node.id, x, y: node.y + i * fitted.lineHeight, w, h: fitted.lineHeight, fontSize: fitted.fontSize };
  });
}
/** 压在图片上的文字：实际文字行至少一半面积落在某张图片上（该图片在文字下层） */
export function overlayTexts(design) {
  const out = [];
  design.layers.forEach((node, index) => {
    if (node.type !== 'text' || !node.text.trim()) return;
    const rows = textRows(node), total = rows.reduce((s, r) => s + r.w * r.h, 0);
    const image = design.layers.slice(0, index).filter(n => n.type === 'image').reverse()
      .find(img => rows.reduce((s, r) => s + area(r, img), 0) >= total * 0.5);
    if (image) out.push({ node, image, rows, index });
  });
  return out;
}
async function measure(design, compose, raster, signal, candidates) {
  const result = await raster(withoutText(compose(design)), { signal });
  throwControl(null, signal);
  const image = await decodePngRgba(new Uint8Array(await result.blob.arrayBuffer()));
  if (!image || image.width !== design.width || image.height !== design.height) return null;
  return candidates.filter(c => !measureTextContrast(image, c.rows, c.node.color).ok);
}
/** 相邻（上下间距小于一行字）且压在同一张图上的文字合成一组，共用一条遮罩 */
function clusters(failed) {
  const groups = [];
  for (const item of [...failed].sort((a, b) => a.rows[0].y - b.rows[0].y)) {
    const top = item.rows[0].y, bottom = item.rows.at(-1).y + item.rows.at(-1).h, size = item.rows[0].fontSize;
    const last = groups.at(-1);
    if (last && last.image === item.image && top - last.bottom <= Math.max(size, last.size)) {
      last.items.push(item); last.bottom = Math.max(last.bottom, bottom); last.size = Math.max(last.size, size);
    } else groups.push({ image: item.image, items: [item], top, bottom, size });
  }
  return groups;
}
function scrimLayer(design, group, n, level) {
  const { image } = group, imageBottom = image.y + image.h;
  // 渐变过渡要够长才不像一条色带：至少两行字高、且不短于图片高度的一成
  const soft = Math.max(48, group.size * 2, image.h * 0.1);
  let y = Math.max(image.y, group.top - soft), bottom = Math.min(imageBottom, group.bottom + soft * 0.6);
  // 离图片上下边不远就直接铺到边，形成常见的“底部压暗”而不是悬在中间的一条
  if (imageBottom - group.bottom < image.h * 0.25) bottom = imageBottom;
  if (group.top - image.y < image.h * 0.2) y = image.y;
  // 浅色字配深色遮罩，深色字配浅色遮罩；画布底色合适就用底色，跟整体配色一致
  // 按哪种底对比度更高来选：亮度 0.179 是黑底、白底对比相等的分界（2026-11-18：橙色字原按 0.4 分界被配了白遮罩，越遮越看不清）
  const light = luminanceHex(group.items[0].node.color) > 0.179, bg = design.palette.background;
  const fill = light ? (luminanceHex(bg) < 0.08 ? bg : '#0B0D12') : (luminanceHex(bg) > 0.75 ? bg : '#FFFFFF');
  const span = bottom - y, fadeTop = y > image.y ? round(Math.min(0.7, (group.top - y) / span)) : 0;
  const fadeBottom = bottom < imageBottom ? round(Math.max(fadeTop, (group.bottom - y) / span)) : 1;
  const stops = [...(fadeTop ? [[0, 0]] : []), [fadeTop, level], [fadeBottom, level], ...(fadeBottom < 1 ? [[1, 0]] : [])];
  return { id: `scrim-${n}`, type: 'shape', x: image.x, y: round(y), w: image.w, h: round(span), fill, color: fill, group: `scrim-${n}`,
    category: '', detail: '', decorative: true, radius: 0, fade: { stops: stops.length < 2 ? [[0, level], [1, level]] : stops } };
}
/**
 * 原地给 design 加遮罩并返回说明；compose 生成 SVG，raster 渲染 PNG。
 * 没有压图文字时不渲染、不花时间；解码不了如实返回 not_checked。
 */
export async function protectOverlayText(design, { compose, raster, signal } = {}) {
  const candidates = overlayTexts(design);
  if (!candidates.length) return { status: 'skipped', scrims: [] };
  let failed = await measure(design, compose, raster, signal, candidates);
  if (failed === null) return { status: 'not_checked', scrims: [] };
  if (!failed.length) return { status: 'passed', scrims: [] };
  const groups = clusters(failed), start = Math.max(0, ...design.layers.map(n => Number(/^scrim-(\d+)$/.exec(n.id)?.[1]) || 0)) + 1;
  const ids = groups.map((_, i) => `scrim-${start + i}`);
  let level = 0;
  for (; level < SCRIM_LEVELS.length; level++) {
    design.layers = design.layers.filter(n => !ids.includes(n.id));
    // 遮罩插在该组最下层文字之前：盖住照片，不盖住文字和文字之间的其它图层
    groups.map((group, i) => ({ group, i, at: Math.min(...group.items.map(item => design.layers.indexOf(item.node))) }))
      .sort((a, b) => b.at - a.at)
      .forEach(({ group, i, at }) => design.layers.splice(at, 0, scrimLayer(design, group, start + i, SCRIM_LEVELS[level])));
    failed = await measure(design, compose, raster, signal, candidates);
    if (failed === null || !failed.length) break;
  }
  const level_ = SCRIM_LEVELS[Math.min(level, SCRIM_LEVELS.length - 1)];
  return { status: failed === null ? 'not_checked' : failed.length ? 'failed' : 'passed', level: level_,
    scrims: groups.map((group, i) => ({ id: ids[i], image: group.image.id, text: group.items.map(item => item.node.id) })) };
}

/**
 * 纯色底上的文字看不清（2026-11-18 用户实测：首卡标题对比度3.95低于4.5，整张海报卡在“待核验”、试排次数用完）：
 * 按去字渲染的真实像素量，不达标就把这段文字换成能看清的颜色——依次试调色板正文色、深灰、白色，
 * 选第一个达标的；只改颜色，不改原文、字号、位置。压在图片上的文字由 protectOverlayText 处理，这里跳过。
 */
export async function fixTextContrast(design, { compose, raster, signal } = {}) {
  const overlay = new Set(overlayTexts(design).map(c => c.node));
  const solid = design.layers.filter(n => n.type === 'text' && n.text.trim() && !overlay.has(n)).map(node => ({ node, rows: textRows(node) }));
  if (!solid.length) return { status: 'skipped', recolored: [] };
  const result = await raster(withoutText(compose(design)), { signal });
  throwControl(null, signal);
  const image = await decodePngRgba(new Uint8Array(await result.blob.arrayBuffer()));
  if (!image || image.width !== design.width || image.height !== design.height) return { status: 'not_checked', recolored: [] };
  const recolored = [], failed = [];
  for (const { node, rows } of solid) {
    if (measureTextContrast(image, rows, node.color).ok) continue;
    const pick = [design.palette.ink, '#111111', '#FFFFFF'].find(color => color !== node.color && measureTextContrast(image, rows, color).ok);
    if (pick) { recolored.push({ id: node.id, from: node.color, to: pick }); node.color = pick; }
    else failed.push(node.id);
  }
  return { status: failed.length ? 'failed' : 'passed', recolored, ...(failed.length && { failed }) };
}
