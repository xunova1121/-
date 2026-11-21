import { normalizePosterBackground } from './posterCompositionInput.js';
import { posterError } from './posterSvg.js';
import { posterWait } from './posterFonts.js';
import { throwControl } from '../core/networkRequest.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

// 部分浏览器宽容错误CRC，因此解码前先核对PNG各块；压缩像素仍须真正解码。
function checkPngCrc(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at < bytes.length;) {
    const size = view.getUint32(at), end = at + size + 8;
    let crc = 0xffffffff;
    for (let index = at + 4; index < end; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end))
      throw posterError('视觉场景底图PNG校验码错误，未输出最终PNG', 'VISUAL_IMAGE_DECODE_INVALID');
    at = end + 4;
  }
}

/** 只读取已经通过静态白名单并规范序列化的image，最多四张、合计10MB/2500万像素。 */
export function rasterImageSources(svg, signal) {
  const images = [];
  for (const match of svg.matchAll(/<image\b[^>]*\bhref="(data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*))"[^>]*\/?\s*>/g)) {
    throwControl(null, signal);
    const bytes = Uint8Array.from(atob(match[3]), ch => ch.charCodeAt(0));
    const checked = normalizePosterBackground({ bytes, mime: 'image/' + match[2] });
    if (match[2] === 'png') checkPngCrc(bytes);
    images.push({ ...checked, bytes });
  }
  return images;
}

/** SVG内的坏图片可能被浏览器静默跳过，所以先单独加载每张底图并核对真实尺寸。 */
export async function checkBrowserRasterImages(svg, { signal } = {}) {
  for (const image of rasterImageSources(svg, signal)) {
    const probe = new Image();
    try {
      await posterWait(new Promise((resolve, reject) => {
        probe.onload = resolve;
        probe.onerror = () => reject(posterError('视觉场景底图无法解码，未输出最终PNG', 'VISUAL_IMAGE_DECODE_INVALID'));
        probe.src = image.data;
      }), signal);
      throwControl(null, signal);
      if (probe.naturalWidth !== image.width || probe.naturalHeight !== image.height)
        throw posterError('视觉场景底图解码尺寸不符，未输出最终PNG', 'VISUAL_IMAGE_DECODE_INVALID');
    } finally {
      probe.onload = probe.onerror = null;
      probe.src = '';
    }
  }
}
