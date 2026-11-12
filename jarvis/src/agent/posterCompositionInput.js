/** 海报输入只接受有界的文字、颜色和真实图片字节，不接收图片 URL 或任意 SVG。 */
import { imageInfo } from './imageInfo.js';

export const POSTER_LIMITS = Object.freeze({
  minSide: 256,
  maxSide: 4096,
  maxPixels: 16e6,
  maxText: 6000,
  maxLines: 32,
  maxImageBytes: 10e6,
  maxImagePixels: 25e6
});

const FONT_FAMILIES = {
  sans: ['Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Droid Sans Fallback'],
  serif: ['Noto Serif CJK SC', 'SimSun', 'Songti SC', 'Noto Serif SC', 'Source Han Serif SC']
};

export function posterError(message, code = 'INVALID_POSTER', details = {}) {
  return Object.assign(new Error(message), { name: 'ValidationError', code, kind: 'input', details });
}

function textValue(value, field) {
  if (typeof value !== 'string' || value.length > POSTER_LIMITS.maxText) {
    throw posterError(`海报 ${field} 必须是 ${POSTER_LIMITS.maxText} 字符以内的文字`, 'INVALID_POSTER', { field });
  }
  // XML 1.0 不接受控制字符和孤立代理项；拒绝而不是静默删字。
  for (const ch of value) {
    const point = ch.codePointAt(0);
    if ((point < 32 && point !== 10 && point !== 13) || (point >= 0xd800 && point <= 0xdfff) || point === 0xfffe || point === 0xffff) {
      throw posterError(`海报 ${field} 含不能排版的控制字符`, 'INVALID_POSTER', { field });
    }
  }
  return value.replace(/\r\n?/g, '\n');
}

function colorValue(value, field) {
  if (typeof value !== 'string' || !/^#?[\da-f]{6}$/i.test(value)) {
    throw posterError(`${field} 需使用六位十六进制颜色，如 #FFFFFF`, 'INVALID_POSTER', { field });
  }
  return `#${value.replace('#', '').toUpperCase()}`;
}

function luminance(color) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

function posterColors(options, hasBody) {
  const textColor = colorValue(options.text_color ?? '#FFFFFF', 'text_color');
  const defaultPanel = contrastRatio(textColor, '#FFF8EC') > contrastRatio(textColor, '#132039') ? '#FFF8EC' : '#132039';
  const panelColor = colorValue(options.panel_color ?? defaultPanel, 'panel_color');
  const contrast = contrastRatio(textColor, panelColor);
  const minimum = hasBody ? 4.5 : 3;
  if (contrast < minimum) throw posterError('文字颜色与文字区底色对比不足，不能保证可读；请调整配色。', 'POSTER_COLOR_CONTRAST', { contrast, minimum });
  return { textColor, panelColor, backgroundColor: colorValue(options.background_color ?? '#132039', 'background_color') };
}

/** 文字不截断，不自动删除空行；小数比例明确表示文字区在指定方向的占比。 */
export function normalizePosterInput(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw posterError('海报参数必须是对象');
  const { width = 1080, height = 1920, text_position = 'bottom', text_fraction = 0.48, font_family = 'sans' } = options;
  if (![width, height].every((v) => Number.isInteger(v) && v >= POSTER_LIMITS.minSide && v <= POSTER_LIMITS.maxSide) || width * height > POSTER_LIMITS.maxPixels) {
    throw posterError('海报宽高需为256–4096的整数，且总像素不超过1600万', 'INVALID_POSTER', { field: 'width/height' });
  }
  if (!['top', 'bottom', 'left', 'right', 'center'].includes(text_position)) throw posterError('文字位置必须是 top、bottom、left、right 或 center');
  if (!Number.isFinite(text_fraction) || text_fraction < 0.15 || text_fraction > 1) throw posterError('文字区比例需在0.15到1之间');
  if (!Object.hasOwn(FONT_FAMILIES, font_family)) throw posterError('字体需为 sans 或 serif');
  const title = textValue(options.title, 'title');
  if (!title.trim()) throw posterError('海报要有主标题');
  const subtitle = textValue(options.subtitle ?? '', 'subtitle');
  const footer = textValue(options.footer ?? '', 'footer');
  const sourceLines = options.lines ?? [];
  if (!Array.isArray(sourceLines) || sourceLines.length > POSTER_LIMITS.maxLines) throw posterError('海报要点最多32条');
  const lines = Array.from(sourceLines, (line, index) => textValue(line, `lines[${index}]`));
  const texts = [title, subtitle, ...lines, footer];
  if (texts.reduce((sum, value) => sum + value.length, 0) > POSTER_LIMITS.maxText) throw posterError('海报文字总量不能超过6000字符');
  const fonts = [...FONT_FAMILIES[font_family]];
  return {
    width, height, title, subtitle, lines, footer, texts, fonts,
    text_position, text_fraction, font_family,
    fontFamily: `${fonts.join(', ')}, ${font_family === 'serif' ? 'serif' : 'sans-serif'}`,
    ...posterColors(options, Boolean(subtitle || footer || lines.some((line) => line.trim())))
  };
}

export function posterPngInfo(bytes) {
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return null;
  if (bytes.length < 45) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hasHeader = false;
  let hasData = false;
  let at = 8;
  let chunks = 0;
  while (at + 12 <= bytes.length && chunks++ < 2048) {
    const size = view.getUint32(at);
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + size + 12;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(kind) || ['acTL', 'fcTL', 'fdAT'].includes(kind)) return null;
    if (!hasHeader && (kind !== 'IHDR' || size !== 13)) return null;
    if (kind === 'IHDR') {
      if (hasHeader || at !== 8 || size !== 13) return null;
      hasHeader = true;
    }
    if (kind === 'IDAT') hasData = hasData || size > 0;
    if (kind === 'IEND') return size === 0 && end === bytes.length && hasData ? imageInfo(bytes) : null;
    at = end;
  }
  return null;
}

function jpegInfo(bytes) {
  if (bytes.length < 16 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  let at = 2;
  let segments = 0;
  while (at + 4 < bytes.length && segments++ < 2048) {
    if (bytes[at++] !== 255) return null;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (!marker || marker === 216 || marker === 217 || (marker >= 208 && marker <= 215)) return null;
    if (marker === 1) continue;
    const size = bytes[at] * 256 + bytes[at + 1];
    if (size < 2 || at + size >= bytes.length) return null;
    // SOS之后是压缩像素流，最终仍由真实图片解码器检查，不能拿本函数冒充视觉验收。
    if (marker === 218) return imageInfo(bytes);
    at += size;
  }
  return null;
}

function webpFrameInfo(bytes, offset, kind, size) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'VP8 ' && size >= 10 && bytes[offset + 3] === 0x9d && bytes[offset + 4] === 1 && bytes[offset + 5] === 0x2a) {
    return { width: view.getUint16(offset + 6, true) & 0x3fff, height: view.getUint16(offset + 8, true) & 0x3fff };
  }
  if (kind === 'VP8L' && size >= 5 && bytes[offset] === 0x2f) {
    const bits = view.getUint32(offset + 1, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function webpInfo(bytes) {
  if (bytes.length < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return null;
  let at = 12;
  let chunks = 0;
  let frame = null;
  let canvas = null;
  while (at + 8 <= bytes.length && chunks++ < 2048) {
    const kind = ascii(at);
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    if (end > bytes.length || ['ANIM', 'ANMF'].includes(kind)) return null;
    if (kind === 'VP8X') {
      if (size !== 10 || at !== 12 || (bytes[at + 8] & 2)) return null;
      const u24 = (offset) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
      canvas = { width: u24(at + 12) + 1, height: u24(at + 15) + 1 };
    }
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (frame) return null;
      frame = webpFrameInfo(bytes, at + 8, kind, size);
      if (!frame) return null;
    }
    at = end;
  }
  if (canvas && frame && (canvas.width !== frame.width || canvas.height !== frame.height)) return null;
  return at === bytes.length ? frame : null;
}

/** 只对受控数据 URI 编码；10MB上限在分块转字符串之前检查。 */
function imageBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function normalizePosterBackground(background) {
  if (background == null) return null;
  const { bytes, mime } = background;
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > POSTER_LIMITS.maxImageBytes) {
    throw posterError('海报底图需为10MB以内的真实图片字节', 'INVALID_POSTER', { field: 'background' });
  }
  let info = null;
  let actualMime = '';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    info = posterPngInfo(bytes);
    actualMime = 'image/png';
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    info = jpegInfo(bytes);
    actualMime = 'image/jpeg';
  } else {
    info = webpInfo(bytes);
    if (info) actualMime = 'image/webp';
  }
  if (!info || actualMime !== mime || !info.width || !info.height || info.width * info.height > POSTER_LIMITS.maxImagePixels) {
    throw posterError('海报底图格式与字节不符、尺寸无效或超过2500万像素；仅支持静态PNG/JPEG/WebP', 'INVALID_POSTER', { field: 'background' });
  }
  return { width: info.width, height: info.height, mime, data: `data:${mime};base64,${imageBase64(bytes)}` };
}
