/**
 * 嵌入前把过大的配图缩到够用的尺寸（2026-11-18 用户实测：4 张约 2MB 的配图原样嵌进去，SVG 11.7MB，渲染失败、海报没交出来）。
 *
 * 只换渲染用的内嵌数据（data），原图字节、路径和摘要不动——源稿续改、打包仍用原图。
 * 够用 = 该图在画布上实际显示尺寸的 1.5 倍（cover 按铺满算）；原图不到 1.2MB 或本来就不大的不动；
 * 缩完反而更大（照片转 PNG 可能变大）就保留原图。
 */
import { normalizePosterBackground } from './posterCompositionInput.js';
import { DESIGN_FONT } from './layeredDesignSvg.js';
import { throwControl } from '../core/networkRequest.js';

export const ASSET_SHRINK = { minBytes: 1.2e6, headroom: 1.5, maxScale: 0.8 };

/** 每张素材需要的缩放比例（≤1）；没被图片图层用到的返回 1 */
export function neededScale(design, id, image) {
  const scales = design.layers.filter(n => n.type === 'image' && n.asset === id)
    .map(n => (n.fit === 'contain' ? Math.min : Math.max)(n.w / image.width, n.h / image.height) * ASSET_SHRINK.headroom);
  return scales.length ? Math.min(1, Math.max(...scales)) : 1;
}

export async function shrinkDesignAssets(design, assets, { raster, signal } = {}) {
  const shrunk = [];
  for (const [id, image] of assets) {
    throwControl(null, signal);
    const scale = neededScale(design, id, image);
    if (image.bytes.length < ASSET_SHRINK.minBytes || scale > ASSET_SHRINK.maxScale) continue;
    const w = Math.max(16, Math.round(image.width * scale)), h = Math.max(16, Math.round(image.height * scale));
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="${image.data}"/><g opacity="0"><text x="2" y="20" font-family="${DESIGN_FONT}" font-size="12" fill="#000000">字</text></g></svg>`;
      const out = await raster(svg, { signal });
      const bytes = new Uint8Array(await out.blob.arrayBuffer());
      const info = normalizePosterBackground({ bytes, mime: 'image/png' });
      if (!info || bytes.length >= image.bytes.length) continue;
      assets.set(id, { ...image, data: info.data });
      shrunk.push({ id, from: image.bytes.length, to: bytes.length, size: `${w}x${h}` });
    } catch (error) { throwControl(error, signal); }
  }
  return shrunk;
}
