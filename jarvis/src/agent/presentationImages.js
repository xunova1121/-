/** 图片是内容版式的一个槽位，不抢走数字卡/表格/流程。最多四图，剩余必须上报。 */
export function imageSlots(kind, count = 1) {
  const area = kind === 'cover' ? { x: 0, y: 0, w: 13.333, h: 7.5 }
    : kind === 'image' ? { x: 0.6, y: 1.55, w: 12.133, h: 5.15 }
    : kind === 'imageText' ? { x: 7, y: 1.55, w: 5.7, h: 5.15 }
    : { x: 10.05, y: 1.55, w: 2.65, h: 5.15 };
  const n = Math.min(4, Math.max(1, count));
  if (n === 1) return [area];
  const columns = area.w > 4 && n > 2 ? 2 : 1, rows = Math.ceil(n / columns), gap = 0.12;
  const w = (area.w - gap * (columns - 1)) / columns, h = (area.h - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({ x: area.x + i % columns * (w + gap), y: area.y + Math.floor(i / columns) * (h + gap), w, h }));
}
/** 为已有内容布局预留侧栏；只变内容区域坐标，不降低字体，最终仍经原溢出检查。 */
export function reserveImageColumn(slide) {
  const originals = new Map();
  const adapt = (options = {}, method) => {
    const { x = 0, y = 0, w = 0 } = options;
    if (y < 1.45 || y >= 6.9 || !w) return options;
    const ratio = 9 / 12.133;
    const square = ['addImage', 'addShape'].includes(method) && Math.abs(Number(options.h) - w) < 0.001;
    return { ...options, ...(square && { h: options.h * ratio, y: y + options.h * (1 - ratio) / 2 }), x: 0.6 + (x - 0.6) * ratio, w: w * ratio,
      ...(options.colW && { colW: options.colW.map(value => value * ratio) }) };
  };
  for (const [method, position] of [['addText', 1], ['addShape', 1], ['addImage', 0], ['addTable', 1], ['addChart', 2]]) {
    const original = slide[method]; originals.set(method, original);
    slide[method] = (...args) => { args[position] = adapt(args[position], method); return original.apply(slide, args); };
  }
  return () => { for (const [method, original] of originals) slide[method] = original; };
}
export async function placeSlideImages(slide, images, kind, { load, missingImages }) {
  const slots = imageSlots(kind, images.length);
  for (const [i, img] of images.entries()) {
    if (!slots[i]) { missingImages.push(`${img.src}（本页最多4图，未放入）`); continue; }
    const pic = await load(img.src);
    if (!pic) continue;
    const area = slots[i];
    slide.addImage({ data: pic.data, ...area, sizing: { type: 'cover', w: area.w, h: area.h }, objectName: `wy-content-${i + 1}`, altText: String(img.alt || '').slice(0, 240) });
  }
}
