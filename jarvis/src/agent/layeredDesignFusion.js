/**
 * 自由图层稿的“图文融合”整理（2026-11-17 用户：海报像硬拼的，需要图文融合）。
 *
 * 自由稿的坐标由模型逐个给出，常见三个问题：
 *   1. 图片是一块矩形，下面直接接纯色文字区，接缝很硬；
 *   2. 标题恰好压在图片下沿的接缝上，一半在图上一半在色块上；
 *   3. 每段文字框比字高很多，段落间距忽大忽小，下面空一大片。
 *
 * 这里在排版之后、出图之前做两件事，只动图层位置和装饰，不改原文、字号、画幅和素材：
 *   A. 融合：横向铺满的图片如果在画面中间结束，在它下沿加一条“透明 → 下方底色”的渐变带，让照片自然过渡到文字区；
 *      压在接缝上的文字会被包进渐变带的深色部分，保证可读。
 *   B. 节奏：同一列上下堆叠的多段文字，把每个框收紧到文字实际高度，再按统一间距重新排；
 *      剩余空间上下均分，不把空白都堆在某两段之间。底部脚注保持贴底。
 * 任一步判断不安全（例如列里夹着卡片、图标或图表）就跳过这一步，不硬改。
 */
import { fitDesignText } from './layeredDesignInput.js';

const overlapX = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5;
const overlapY = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
const covers = (shape, x, y) => x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
const round = (n) => Math.round(n * 1000) / 1000;

/** 某点下方实际露出来的底色：取画在最上层、覆盖这一点的实色形状，否则用画布底色 */
function colorAt(design, x, y, upTo) {
  for (let i = upTo - 1; i >= 0; i--) {
    const node = design.layers[i];
    if (node.type === 'shape' && !node.fade && covers(node, x, y)) return node.fill;
  }
  return design.palette.background;
}

/** A. 图片下沿融合渐变 */
function fuseImages(design, notes) {
  const { width, height } = design;
  for (const image of design.layers.filter((n) => n.type === 'image')) {
    const bottom = image.y + image.h;
    // 只处理横向基本铺满、且在画面中间结束的大图；小插图、卡片里的图不加
    if (image.w < width * 0.8 || bottom > height - 40 || image.h < height * 0.12) continue;
    if (design.layers.some((n) => n.id === `fuse-${image.id}`)) continue;
    const index = design.layers.indexOf(image);
    const below = colorAt(design, image.x + image.w / 2, Math.min(height - 1, bottom + 4), design.layers.length);
    // 压在图片下半部、跨过接缝的文字：渐变要在它上沿之前就加深
    const riding = design.layers.filter(
      (n) => n.type === 'text' && n.text.trim() && overlapX(n, image) && n.y < bottom && n.y + n.h > bottom - image.h * 0.45 && n.y >= image.y + image.h * 0.3
    );
    const textTop = riding.length ? Math.min(...riding.map((n) => n.y)) : null;
    let top = bottom - Math.max(60, image.h * 0.22);
    if (textTop !== null) top = Math.min(top, textTop - Math.max(24, image.h * 0.06));
    top = Math.max(image.y + image.h * 0.3, top);
    const span = bottom - top;
    if (span < 24) continue;
    const stops =
      textTop !== null ? [[0, 0], [round(Math.min(0.9, Math.max(0.15, (textTop - top) / span))), 0.88], [1, 1]] : [[0, 0], [0.55, 0.7], [1, 1]];
    design.layers.splice(index + 1, 0, {
      id: `fuse-${image.id}`, type: 'shape', x: image.x, y: round(top), w: image.w, h: round(span), fill: below, color: below,
      group: `fuse-${image.id}`, category: '', detail: '', decorative: true, radius: 0, fade: { stops }
    });
    notes.push({ id: `fuse-${image.id}`, kind: 'image_fade', image: image.id, color: below, from: round(top), to: round(bottom), ...(textTop !== null && { text: riding.map((n) => n.id) }) });
  }
}

/** B. 同列多段文字统一间距 */
function rhythm(design, notes) {
  const texts = design.layers.filter((n) => n.type === 'text' && n.text.trim() && !n.decorative);
  if (texts.length < 3) return;
  // 找最大的一列：左边界接近、宽度接近
  const columns = [];
  for (const node of texts) {
    const column = columns.find((c) => Math.abs(c[0].x - node.x) <= 12 && Math.abs(c[0].w - node.w) <= c[0].w * 0.15);
    if (column) column.push(node);
    else columns.push([node]);
  }
  const column = columns.sort((a, b) => b.length - a.length)[0].sort((a, b) => a.y - b.y);
  if (column.length < 3) return;
  for (let i = 1; i < column.length; i++) if (overlapY(column[i - 1], column[i])) return; // 本来就叠在一起：不判断意图，跳过
  // 底部脚注（最后一段、贴近底边、字更小）保持原位，作为下边界
  const last = column.at(-1), sizes = column.map((n) => n.fontSize).sort((a, b) => a - b), body = sizes[Math.floor(sizes.length / 2)];
  const anchored = last.y + last.h >= design.height - design.height * 0.08 && last.fontSize < body ? last : null;
  const moving = anchored ? column.slice(0, -1) : column;
  if (moving.length < 3) return;
  const start = moving[0].y, end = anchored ? anchored.y - body * 0.8 : moving.at(-1).y + moving.at(-1).h;
  const xs = Math.min(...moving.map((n) => n.x)), xe = Math.max(...moving.map((n) => n.x + n.w));
  const region = { x: xs, y: start, w: xe - xs, h: end - start };
  // 列里夹着卡片、图标、图表或其它文字：重排会碰到它们，跳过
  const others = design.layers.filter((n) => !moving.includes(n) && n !== anchored && !n.decorative && overlapX(n, region) && overlapY(n, region));
  if (others.some((n) => n.type !== 'shape' && n.type !== 'image')) return;
  if (others.some((n) => n.type === 'shape' && !(n.x <= region.x && n.x + n.w >= region.x + region.w && n.y <= region.y && n.y + n.h >= region.y + region.h))) return;
  // 图片只允许压到第一段（常见：标题骑在图片下沿）；伸进后面的段落就跳过
  if (others.some((n) => n.type === 'image' && n.y + n.h > moving[1].y - 1)) return;
  const heights = moving.map((n) => {
    const fitted = fitDesignText(n);
    return Math.ceil(fitted.rows.length * fitted.lineHeight * 1000) / 1000;
  });
  const gaps = moving.slice(1).map((n, i) => n.y - (moving[i].y + moving[i].h));
  const slack = moving.map((n, i) => n.h - heights[i]);
  const irregular = Math.max(...gaps) - Math.min(...gaps) > body * 1.2 || Math.max(...slack) > body * 1.5;
  if (!irregular) return;
  const free = end - start - heights.reduce((s, h) => s + h, 0);
  if (free < 0) return;
  // 标题/大字后面紧跟副标题，间距取一半，层级才分得清；其余段落之间等距
  const weights = moving.slice(0, -1).map((n) => (n.fontSize >= body * 1.3 ? 0.45 : 1));
  const unit = Math.min(body * 3, Math.max(body * 0.7, free / weights.reduce((s, w) => s + w, 0)));
  // 第一段（常是标题，可能骑在融合后的图片上）位置不动；用不完的空间留在末段和脚注之间，不塞进段落之间
  let y = start;
  const moved = [];
  moving.forEach((node, i) => {
    const before = { y: node.y, h: node.h };
    node.y = round(y);
    node.h = heights[i];
    y += heights[i] + (weights[i] ?? 0) * unit;
    if (before.y !== node.y || before.h !== node.h) moved.push({ id: node.id, from: before, to: { y: node.y, h: node.h } });
  });
  if (moved.length) notes.push({ kind: 'text_rhythm', gap: round(unit), moved });
}

/** 返回整理说明；design 原地修改（调用方传入的是待归一化的草稿） */
export function fuseLayerDesign(design) {
  const notes = [];
  rhythm(design, notes);
  fuseImages(design, notes);
  return notes;
}
