/** 读取收到的图片容器元数据；像素尺寸不是细节清晰度或视觉验收。始终保留原字节。 */
import { imageFormat } from './imageFormat.js';
import { throwControl } from '../core/networkRequest.js';

const MAX_BYTES = 24e6;
const MAX_CHUNKS = 2048;
const validSize = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 100000 && height < 100000;
const sizeOf = (width, height) => validSize(width, height) ? { width, height } : null;
const ascii = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));

function pngDimensions(bytes, view) {
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return null;
  let dimensions = null;
  let hasData = false;
  let at = 8;
  for (let chunks = 0; at + 12 <= bytes.length && chunks < MAX_CHUNKS; chunks++) {
    const length = view.getUint32(at);
    const kind = ascii(bytes, at + 4);
    const end = at + length + 12;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(kind)) return null;
    if (!dimensions && (kind !== 'IHDR' || length !== 13 || at !== 8)) return null;
    if (kind === 'IHDR') {
      if (dimensions || length !== 13 || at !== 8) return null;
      dimensions = sizeOf(view.getUint32(at + 8), view.getUint32(at + 12));
      if (!dimensions) return null;
    }
    if (kind === 'IDAT') hasData = hasData || length > 0;
    if (kind === 'IEND') return length === 0 && end === bytes.length && hasData ? dimensions : null;
    at = end;
  }
  return null;
}

function jpegDimensions(bytes, view) {
  if (bytes.length < 16 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  let at = 2;
  let dimensions = null;
  for (let segments = 0; at + 4 < bytes.length && segments < MAX_CHUNKS; segments++) {
    if (bytes[at++] !== 255) return null;
    while (at < bytes.length && bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (!marker || marker === 216 || marker === 217 || (marker >= 208 && marker <= 215)) return null;
    if (marker === 1) continue;
    if (at + 2 > bytes.length) return null;
    const length = view.getUint16(at);
    if (length < 2 || at + length >= bytes.length) return null;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (dimensions || length < 8 || length !== 8 + 3 * bytes[at + 7]) return null;
      dimensions = sizeOf(view.getUint16(at + 5), view.getUint16(at + 3));
      if (!dimensions) return null;
    }
    // 压缩像素流交给实际解码器；这里只核对SOF与完整容器，不声称已解码或已看清。
    if (marker === 218) return dimensions;
    at += length;
  }
  return null;
}

function webpFrame(bytes, view, at, kind, length) {
  if (kind === 'VP8 ' && length >= 10 && bytes[at + 3] === 157 && bytes[at + 4] === 1 && bytes[at + 5] === 42)
    return sizeOf(view.getUint16(at + 6, true) & 0x3fff, view.getUint16(at + 8, true) & 0x3fff);
  if (kind === 'VP8L' && length >= 5 && bytes[at] === 47) {
    const bits = view.getUint32(at + 1, true);
    return sizeOf((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

function webpDimensions(bytes, view) {
  if (bytes.length < 20 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return null;
  let at = 12;
  let frame = null;
  let canvas = null;
  for (let chunks = 0; at + 8 <= bytes.length && chunks < MAX_CHUNKS; chunks++) {
    const kind = ascii(bytes, at);
    const length = view.getUint32(at + 4, true);
    const end = at + 8 + length + length % 2;
    if (end > bytes.length || ['ANIM', 'ANMF'].includes(kind)) return null;
    if (kind === 'VP8X') {
      if (length !== 10 || at !== 12 || (bytes[at + 8] & 2)) return null;
      const u24 = offset => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
      canvas = sizeOf(u24(at + 12) + 1, u24(at + 15) + 1);
      if (!canvas) return null;
    }
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (frame) return null;
      frame = webpFrame(bytes, view, at + 8, kind, length);
      if (!frame) return null;
    }
    at = end;
  }
  if (canvas && frame && (canvas.width !== frame.width || canvas.height !== frame.height)) return null;
  return at === bytes.length ? frame : null;
}

/** 未识别或不完整时保留unknown，不能拿请求尺寸填充；最多读取24MB、2048个容器段。 */
export async function readImageMetadata(blob, { signal } = {}) {
  throwControl(null, signal);
  const format = await imageFormat(blob);
  const supported = ['png', 'jpg', 'webp'].includes(format?.ext);
  let dimensions = null;
  if (supported && blob.size <= MAX_BYTES) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dimensions = ({ png: pngDimensions, jpg: jpegDimensions, webp: webpDimensions })[format.ext](bytes, view);
  }
  throwControl(null, signal);
  return {
    width: dimensions?.width ?? null, height: dimensions?.height ?? null,
    format: format?.ext === 'jpg' ? 'jpeg' : format?.ext || 'unknown', mime: format?.mime || null, bytes: blob.size,
    dimensions: dimensions ? 'verified' : 'unknown', verification: dimensions ? 'container_metadata' : 'not_checked'
  };
}

/** 只保存真正发送的有界参数；不记录提示词、URL或请求头，未指定参数不冒充默认值。 */
export function imageRequestReceipt(model, parameters = {}) {
  if (!parameters || typeof parameters !== 'object') parameters = {};
  const pick = (key, choices) => choices.includes(parameters[key]) ? parameters[key] : null;
  return {
    model: String(model || '').slice(0, 160),
    size: /^(?:auto|\d{2,5}x\d{2,5})$/.test(parameters.size) ? parameters.size : null,
    quality: pick('quality', ['auto', 'low', 'medium', 'high']),
    output_format: pick('output_format', ['png', 'jpeg', 'webp']), background: pick('background', ['auto', 'opaque', 'transparent'])
  };
}

export function imageSizeMatch(requested, actual) {
  const match = /^(\d+)x(\d+)$/.exec(requested?.size || '');
  return match && actual?.dimensions === 'verified' ? actual.width === Number(match[1]) && actual.height === Number(match[2]) : null;
}

export function imageFormatMatch(requested, actual) {
  return requested?.output_format && ['png', 'jpeg', 'webp'].includes(actual?.format) ? requested.output_format === actual.format : null;
}

/** cover倍率由真实底图尺寸计算；4K画布不证明底图具有4K细节。 */
export function imageCoverReceipt(actual, width, height) {
  if (actual?.dimensions !== 'verified') return { ...actual, fit: 'cover', scale: null, upscaled: null, cropped: null, detail: 'not_checked' };
  const scale = Math.max(width / actual.width, height / actual.height);
  return { ...actual, fit: 'cover', scale, upscaled: scale > 1, cropped: actual.width * height !== actual.height * width, detail: 'not_checked' };
}
