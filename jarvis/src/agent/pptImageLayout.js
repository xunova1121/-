/** 图片区域先于配图确定；坐标单位英寸，宽高比与裁切均来自实际几何，不靠内容关键词猜。 */
export const PICTURE_PAGE = { w: 13.333, h: 7.5 };
export const PICTURE_BODY = { x: 0.6, y: 1.3, w: 12.133, h: 5.55 };
const AREA = PICTURE_PAGE.w * PICTURE_PAGE.h;
const rect = (x, y, w, h) => ({ x, y, w, h });

export function picturePlacement(area, ratio = 1) {
  ratio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const target = area.w / area.h;
  const wouldCrop = 1 - Math.min(ratio / target, target / ratio);
  if (wouldCrop <= 0.25 + 1e-8) return { ...area, sizing: 'cover', cropRatio: wouldCrop, areaRatio: (area.w * area.h) / AREA };
  const w = Math.min(area.w, area.h * ratio),
    h = w / ratio;
  return {
    x: area.x + (area.w - w) / 2,
    y: area.y + (area.h - h) / 2,
    w,
    h,
    sizing: 'contain',
    cropRatio: 0,
    avoidedCropRatio: wouldCrop,
    areaRatio: (w * h) / AREA
  };
}

/** 纯规则入口；previous保存上一页真实图片位置，连续分栏才交替。 */
export function selectPictureLayout({ count = 1, ratios = [], items = 0, chars = 0, structured = false, previous = null, style = 'business' } = {}) {
  count = Math.min(4, Math.max(1, count));
  const ratio = ratios[0] || (items <= 3 && chars <= 80 && !structured ? 16 / 9 : 0.8);
  let name,
    reason,
    text = null,
    areas;
  if (count > 1) {
    name = `gallery-${count}`;
    reason = { 2: '两图并排，便于同尺度比较', 3: '一大两小，建立主次视觉', 4: '田字格，统一间距与阅读顺序' }[count];
    const b = PICTURE_BODY,
      gap = 0.18;
    if (count === 2) areas = [0, 1].map((i) => rect(b.x + (i * (b.w + gap)) / 2, b.y, (b.w - gap) / 2, b.h));
    else if (count === 3) {
      const left = (b.w - gap) * 0.58,
        right = b.w - gap - left,
        h = (b.h - gap) / 2;
      areas = [rect(b.x, b.y, left, b.h), rect(b.x + left + gap, b.y, right, h), rect(b.x + left + gap, b.y + h + gap, right, h)];
    } else
      areas = Array.from({ length: 4 }, (_, i) =>
        rect(b.x + ((i % 2) * (b.w + gap)) / 2, b.y + (Math.floor(i / 2) * (b.h + gap)) / 2, (b.w - gap) / 2, (b.h - gap) / 2)
      );
  } else if (!structured && items <= 3 && chars <= 80 && ratio >= 1.4) {
    name = 'hero';
    reason = '短文与横图采用全幅主图、底部原生文字，避免横图塞入竖栏';
    areas = [rect(0, 0, PICTURE_PAGE.w, PICTURE_PAGE.h)];
    text = rect(0.85, 5.25, 11.63, 1.42);
  } else {
    name = structured || items >= 6 || chars > 220 ? 'split-wide' : 'split';
    reason = name === 'split-wide' ? '表格或密集正文保留约六成文字宽度，图片不再缩成窄栏' : '中等正文与竖图/方图分栏，分别保留阅读空间';
    const imageW = name === 'split-wide' ? 4.55 : 5.85,
      gap = 0.42,
      textW = PICTURE_BODY.w - imageW - gap;
    const side = previous && ['split', 'split-wide'].includes(previous.name) && previous.imageSide === 'right' ? 'left' : 'right';
    areas = [rect(side === 'left' ? 0.6 : 0.6 + textW + gap, 1.3, imageW, 5.55)];
    text = rect(side === 'left' ? 0.6 + imageW + gap : 0.6, 1.4, textW, 5.35);
    const pictures = [picturePlacement(areas[0], ratio)];
    return { name, reason, imageSide: side, text, areas, pictures, ratio: areas[0].w / areas[0].h, style, needsSplit: false };
  }
  const pictures = areas.map((a, i) => picturePlacement(a, ratios[i] || ratio));
  const needsSplit = count > 1 && (chars > 0 || pictures.some((p) => p.areaRatio < 0.125 - 1e-6 || Math.min(p.w, p.h) < 1.8));
  return { name, reason, text, areas, pictures, ratio: areas[0].w / areas[0].h, style, needsSplit };
}

/** 生成器使用该比例，不再先固定封面/窄栏尺寸再强塞。 */
export function pictureRequestSize(layout) {
  if (layout.name === 'cover' || layout.name === 'hero') return '1536x864';
  const ratio = layout.ratio || 0.8;
  const width = ratio >= 1 ? 1024 : Math.max(512, Math.round((1024 * ratio) / 64) * 64);
  const height = ratio >= 1 ? Math.max(512, Math.round(1024 / ratio / 64) * 64) : 1024;
  return `${width}x${height}`;
}
