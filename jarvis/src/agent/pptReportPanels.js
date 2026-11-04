/**
 * 政企汇报风格的图文版式（参考稿“指挥端智能”“执法端智能”“项目成效亮点”）：
 *   imageColumn  左边一列截图 / 照片，图下压一条深色半透明说明条（写图片说明）
 *   tagPanels    右边（或整页）每组一块：左边彩色竖标签写组名，右边是组内要点（带标签的分栏，不带标签的列成条）
 *   labelRows    右边一行一条：蓝色标签块 + 浅底说明（如“渔政法规知识库 | 对接国家法规……”）
 * 图片读取沿用 pptxWriter 的 imageData（同一套缓存、缺图上报），这里只负责摆放。
 */
import { richRuns, inlinesOf, W } from './pptReport.js';

/** 左边图片列：按张数等分高度，图片裁切铺满，底部说明条 */
export async function imageColumn(sl, ctx, images, { x = 0.6, y = 1.7, w = 4.6, h = 5.15 } = {}) {
  const { pptx, load, FONT } = ctx;
  const list = images.slice(0, 4), gap = 0.18;
  const ih = (h - gap * (list.length - 1)) / list.length;
  let placed = 0;
  for (const [k, img] of list.entries()) {
    const yy = y + k * (ih + gap);
    const pic = await load(img.src);
    if (!pic) {
      sl.addShape(pptx.ShapeType.rect, { x, y: yy, w, h: ih, fill: { color: 'EEF2F7' }, line: { color: 'DCE3ED' } });
      sl.addText('图片未取得', { x, y: yy, w, h: ih, fontSize: 12, color: '8A94A6', align: 'center', valign: 'middle', fontFace: FONT });
      continue;
    }
    placed++;
    sl.addImage({ objectName: 'wy-report-image', data: pic.data, x, y: yy, w, h: ih, sizing: { type: 'cover', w, h: ih } });
    const caption = String(img.alt || '').trim();
    if (caption) {
      const bh = Math.min(0.42, ih * 0.22);
      sl.addShape(pptx.ShapeType.rect, { x, y: yy + ih - bh, w, h: bh, fill: { color: '0F1B2D', transparency: 25 }, line: { color: '0F1B2D', transparency: 100 } });
      sl.addText(caption, { objectName: 'wy-caption', x: x + 0.1, y: yy + ih - bh, w: w - 0.2, h: bh, fontSize: 12, bold: true, color: 'FFFFFF', fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
    }
  }
  return placed;
}

/** 竖标签面板：每组一块，左边竖排组名，右边内容 */
export function tagPanels(sl, ctx, groups, { x = 0.6, y = 1.7, w = W - 1.2, h = 5.15 } = {}) {
  const { pptx, T, FONT, labelOf, plain } = ctx;
  const n = Math.min(groups.length, 3), gap = 0.25;
  const gh = (h - gap * (n - 1)) / n;
  const colors = [T.accent, T.subtitle, T.head];
  groups.slice(0, n).forEach((g, k) => {
    const yy = y + k * (gh + gap), tag = 0.62, color = colors[k % colors.length];
    sl.addShape(pptx.ShapeType.rect, { x, y: yy, w, h: gh, fill: { color: 'FFFFFF' }, line: { color: T.border, width: 0.75 } });
    sl.addShape(pptx.ShapeType.rect, { x, y: yy, w: tag, h: gh, fill: { color }, line: { color } });
    // 竖排组名：一字一行（各家软件对竖排文字的支持不一，这样最稳）
    sl.addText([...String(g.title).replace(/\s+/g, '')].slice(0, 10).join('\n'), { x, y: yy, w: tag, h: gh, fontSize: 15, bold: true, color: 'FFFFFF', fontFace: FONT, align: 'center', valign: 'middle', lineSpacingMultiple: 1.05, fit: 'shrink', margin: 2 });
    const items = g.items, labeled = items.filter(it => labelOf(it).label), lead = items.filter(it => !labelOf(it).label);
    const ix = x + tag + 0.3, iw = w - tag - 0.55;
    let top = yy + 0.18;
    if (!labeled.length) {
      // 全是不带标签的要点：左对齐逐条列出，字号按格子大小
      const runs = lead.flatMap((it, i) => [...richRuns(inlinesOf(plain(it.inlines)), { color: T.text, hot: T.hot, num: T.accent }).map((r, j) => ({ ...r, options: { ...r.options, ...(j === 0 && { bullet: { code: '25A0', indent: 16 }, paraSpaceBefore: i ? 8 : 0 }) } })), { text: '', options: { breakLine: true } }]);
      sl.addText(runs, { x: ix, y: top, w: iw, h: gh - 0.36, fontSize: 16, fontFace: FONT, valign: 'middle', lineSpacingMultiple: 1.25, fit: 'shrink', margin: 0 });
      return;
    }
    if (lead.length) {
      sl.addText(richRuns(inlinesOf(lead.map(it => plain(it.inlines)).join('\n')), { color: T.text, hot: T.hot, num: T.accent, bold: true }), { x: ix, y: top, w: iw, h: 0.62, fontSize: 15, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
      top += 0.7;
    }
    const cols = Math.min(labeled.length, 4), cg = 0.2, cw = (iw - cg * (cols - 1)) / cols, chh = yy + gh - 0.18 - top;
    labeled.slice(0, 4).forEach((it, i) => {
      const { label, text } = labelOf(it), cx = ix + i * (cw + cg);
      sl.addShape(pptx.ShapeType.rect, { x: cx, y: top, w: cw, h: chh, fill: { color: T.panel }, line: { color: T.panel } });
      sl.addText(label, { x: cx + 0.12, y: top + 0.08, w: cw - 0.24, h: 0.42, fontSize: 15, bold: true, color: T.accent, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
      sl.addText(richRuns(inlinesOf(text), { color: T.sub, hot: T.hot, num: T.accent }), { x: cx + 0.15, y: top + 0.55, w: cw - 0.3, h: chh - 0.65, fontSize: 14, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25, fit: 'shrink', margin: 0 });
    });
  });
}

/** 一行一条：标签块 + 说明；没有标签的第一句当作红色总起句 */
export function labelRows(sl, ctx, items, { x = 5.5, y = 1.7, w = W - 6.1, h = 5.15 } = {}) {
  const { pptx, T, FONT, labelOf, plain } = ctx;
  const lead = items.filter(it => !labelOf(it).label), rows = items.filter(it => labelOf(it).label).slice(0, 5);
  let top = y;
  if (lead.length) {
    sl.addShape(pptx.ShapeType.rect, { x, y: top, w, h: 0.8, fill: { color: T.soft }, line: { color: T.soft } });
    sl.addText(richRuns(inlinesOf(lead.map(it => plain(it.inlines)).join('；')), { color: T.hot, hot: T.hot, num: T.hot, bold: true }), { x: x + 0.2, y: top, w: w - 0.4, h: 0.8, fontSize: 15, fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
    top += 1.0;
  }
  if (!rows.length) return;
  const gap = 0.22, rh = Math.min(1.5, (y + h - top - gap * (rows.length - 1)) / rows.length), tw = 1.9;
  rows.forEach((it, k) => {
    const { label, text } = labelOf(it), yy = top + k * (rh + gap);
    sl.addShape(pptx.ShapeType.rect, { x, y: yy, w: tw, h: rh, fill: { color: T.accent }, line: { color: T.accent } });
    sl.addText(label, { x: x + 0.1, y: yy, w: tw - 0.2, h: rh, fontSize: 16, bold: true, color: 'FFFFFF', fontFace: FONT, align: 'center', valign: 'middle', fit: 'shrink', margin: 0 });
    sl.addShape(pptx.ShapeType.rect, { x: x + tw + 0.15, y: yy, w: w - tw - 0.15, h: rh, fill: { color: T.panel }, line: { color: T.panel } });
    const cut = String(text).search(/[｜|]/), head = cut > 0 && cut <= 24 ? String(text).slice(0, cut) : '', body = head ? String(text).slice(cut + 1) : text;
    const runs = [...(head ? [{ text: head + '\n', options: { bold: true, color: T.head } }] : []), ...richRuns(inlinesOf(body), { color: T.sub, hot: T.hot, num: T.accent })];
    sl.addText(runs, { x: x + tw + 0.35, y: yy + 0.1, w: w - tw - 0.55, h: rh - 0.2, fontSize: 15, fontFace: FONT, valign: 'middle', lineSpacingMultiple: 1.25, fit: 'shrink', margin: 0 });
  });
}
