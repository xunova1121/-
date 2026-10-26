/**
 * 图片准备：缩放到大模型合适的尺寸（长边 ≤ 1568 像素）、转成 JPEG base64，并生成一张小缩略图用于对话记录。
 * 只在浏览器里用（依赖 createImageBitmap / canvas）。
 */
import { imageFormat } from './imageFormat.js';
import { renderSvg } from './svgPreview.js';

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const isImageName = (name) => IMAGE_EXT.test(String(name));
const MAX_SIDE = 1568;

function toCanvas(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; // 透明背景转 JPEG 时用白底
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0, w, h);
  return c;
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ mime: string, data: string, width: number, height: number, thumb: string }>}
 */
export async function prepareImage(blob, { maxSide = MAX_SIDE, quality = 0.85 } = {}) {
  if ((await imageFormat(blob))?.ext === 'svg') blob = await renderSvg(await blob.text());
  const bitmap = await createImageBitmap(blob);
  try {
    const big = toCanvas(bitmap, maxSide);
    const url = big.toDataURL('image/jpeg', quality);
    const thumb = toCanvas(bitmap, 240).toDataURL('image/jpeg', 0.7);
    return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), width: big.width, height: big.height, thumb };
  } finally {
    bitmap.close?.();
  }
}

/** base64 → Blob（截屏等） */
export function base64ToBlob(b64, mime = 'image/png') {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime });
}
