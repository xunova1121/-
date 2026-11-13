import { picturePlacement, selectPictureLayout, PICTURE_PAGE } from './pptImageLayout.js';
import { throwControl } from '../core/networkRequest.js';

/** 白字对高亮背景保守保证对比；无法读取像素时用64%黑色，不假称已测亮度。 */
export async function pictureContrast(picture) {
  let peak = null;
  if (picture?.bytes?.[0] === 137 && picture.bytes.length <= 8e6) {
    try {
      const { pngPixels } = await import('./diagramPng.js');
      const decoded = await pngPixels(new Blob([picture.bytes]));
      peak = 0;
      // 解码器已限制420万像素，逐像素检查，避免稀疏采样漏掉标题后的亮斑。
      const step = 3;
      for (let i = 0; i < decoded.rgb.length; i += step) peak = Math.max(peak, decoded.rgb[i] / 255, decoded.rgb[i + 1] / 255, decoded.rgb[i + 2] / 255);
    } catch (error) {
      throwControl(error);
    }
  }
  const opacity = peak == null ? 0.64 : Math.max(0.28, Math.min(0.68, 1 - 0.4 / Math.max(0.01, peak)));
  return { opacity, brightnessMeasured: peak != null, peak };
}

export async function placePictureImages(slide, images, plan, { load, missingImages, tokens, shape }) {
  const facts = [];
  for (const [i, image] of images.entries()) {
    if (!plan.pictures[i]) {
      missingImages.push(`${image.src}（本页最多4图，未放入）`);
      continue;
    }
    const pic = await load(image.src);
    if (!pic) continue;
    const area = plan.areas[i],
      fit = plan.pictures[i];
    slide.addShape(shape.rect, {
      objectName: `wy-picture-layout-${plan.name}${plan.imageSide ? '-' + plan.imageSide : ''}`,
      ...area,
      fill: { color: tokens.soft },
      line: { color: tokens.soft, transparency: 100 }
    });
    slide.addImage({
      data: pic.data,
      x: fit.x,
      y: fit.y,
      w: fit.sizing === 'cover' ? fit.h * pic.ratio : fit.w,
      h: fit.h,
      ...(fit.sizing === 'cover' && { sizing: { type: 'cover', w: fit.w, h: fit.h } }),
      objectName: ['hero', 'cover'].includes(plan.name) ? 'wy-content-background' : `wy-content-${i + 1}`,
      altText: String(image.alt || '').slice(0, 240)
    });
    facts.push({ path: image.src, ...fit });
  }
  return facts;
}

/** 封面与正文共用真实比例/裁切规则；文字前有明确深色遮罩才标为背景图。 */
export async function placePictureCover(slide, images, options) {
  const selected = images.slice(0, 4);
  for (const image of images.slice(4)) options.missingImages.push(`${image.src}（本页最多4图，未放入）`);
  const loaded = await Promise.all(selected.map((image) => options.load(image.src)));
  const base = selectPictureLayout({ count: selected.length, ratios: loaded.map((pic) => pic?.ratio || 1) });
  const areas = selected.length === 1 ? [{ x: 0, y: 0, ...PICTURE_PAGE }] : base.areas;
  const plan = { ...base, name: 'cover', areas, pictures: areas.map((area, i) => picturePlacement(area, loaded[i]?.ratio || 1)) };
  const pictures = await placePictureImages(slide, selected, plan, options);
  const contrasts = await Promise.all(loaded.map(pictureContrast));
  const opacity = Math.max(...contrasts.map((c) => c.opacity));
  slide.addShape(options.shape.rect, {
    x: 0,
    y: 0,
    ...PICTURE_PAGE,
    fill: { color: '000000', transparency: Math.round((1 - opacity) * 100) },
    line: { transparency: 100 }
  });
  return {
    page: 1,
    name: 'cover',
    reason: '全幅图片背景，过量裁切改完整容纳，按真实亮度加深色遮罩保证白字清晰',
    pictures,
    contrast: { opacity, brightnessMeasured: contrasts.every((c) => c.brightnessMeasured) }
  };
}
