import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { imageInfo } from './imageInfo.js';

export const POSTER_LIMITS = { sourceBytes: 16e6, imageBytes: 10e6, outputBytes: 24e6, pixels: 16e6, side: 4096, text: 12000, nodes: 3000 };
export const posterError = (message, code = 'POSTER_INPUT', kind = 'input') => Object.assign(new Error(message), { code, kind });
export const POSTER_FONTS = ['Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Droid Sans Fallback', 'Noto Serif CJK SC', 'SimSun', 'Songti SC', 'Noto Serif SC', 'Source Han Serif SC'];
const NS = 'http://www.w3.org/2000/svg';
const attributes = {
  svg: ['xmlns', 'width', 'height', 'viewBox'],
  rect: ['x', 'y', 'width', 'height', 'fill', 'fill-opacity'],
  circle: ['cx', 'cy', 'r', 'fill', 'fill-opacity'],
  image: ['x', 'y', 'width', 'height', 'href', 'preserveAspectRatio'],
  text: ['x', 'y', 'font-size', 'font-family', 'font-weight', 'fill', 'xml:space', 'text-anchor']
};
const numberAttributes = new Set(['x', 'y', 'cx', 'cy', 'r', 'width', 'height', 'font-size', 'fill-opacity']);
const unsafe = () => { throw posterError('海报仅接受程序生成的自包含静态元素和内嵌位图', 'POSTER_UNSAFE'); };

// 先做有界词法检查，避免16MB恶意XML在正式白名单检查之前就建出百万节点/属性。
function preflight(svg) {
  const stack = [];
  let offset = 0, count = 0;
  while ((offset = svg.indexOf('<', offset)) !== -1) {
    const start = /^<(\/?)([A-Za-z_:][\w:.-]*)/.exec(svg.slice(offset));
    if (!start || !Object.hasOwn(attributes, start[2]) || ++count > POSTER_LIMITS.nodes * 2) unsafe();
    offset += start[0].length;
    if (start[1]) {
      const end = /^\s*>/.exec(svg.slice(offset));
      if (!end || stack.pop() !== start[2]) unsafe();
      offset += end[0].length;
      continue;
    }
    if ((stack.length === 0 && start[2] !== 'svg') || stack.length > 1 || (stack.length && stack[0] !== 'svg')) unsafe();
    const seen = new Set();
    let selfClosing = false;
    while (true) {
      const end = /^\s*(\/?)>/.exec(svg.slice(offset));
      if (end) { selfClosing = Boolean(end[1]); offset += end[0].length; break; }
      const attribute = /^\s+([A-Za-z_:][\w:.-]*)\s*=\s*(["'])/.exec(svg.slice(offset));
      if (!attribute || !attributes[start[2]].includes(attribute[1]) || seen.has(attribute[1])) unsafe();
      seen.add(attribute[1]);
      offset += attribute[0].length;
      const finish = svg.indexOf(attribute[2], offset);
      if (finish < 0 || (attribute[1] !== 'href' && finish - offset > 512) || svg.indexOf('<', offset) >= 0 && svg.indexOf('<', offset) < finish) unsafe();
      offset = finish + 1;
    }
    if (!selfClosing) stack.push(start[2]);
  }
  if (stack.length) unsafe();
}

function imageDimensions(bytes, mime) {
  if (mime !== 'webp') {
    const info = imageInfo(bytes);
    const validHeader = mime === 'png'
      ? bytes.slice(0, 8).join() === '137,80,78,71,13,10,26,10' && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return validHeader && info?.type === (mime === 'jpeg' ? 'jpg' : mime) ? info : null;
  }
  if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null;
  const u24 = i => bytes[i] + (bytes[i + 1] << 8) + (bytes[i + 2] << 16);
  const u32 = i => (u24(i) + bytes[i + 3] * 16777216) >>> 0;
  if (u32(4) !== bytes.length - 8) return null;
  let canvas, image, count = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length || ++count > 128) return null;
    const chunk = String.fromCharCode(...bytes.slice(offset, offset + 4)), length = u32(offset + 4), start = offset + 8;
    if (length > bytes.length - start || ['ANIM', 'ANMF'].includes(chunk)) return null;
    if (chunk === 'VP8X') {
      if (canvas || length < 10 || (bytes[start] & 2)) return null;
      canvas = { width: 1 + u24(start + 4), height: 1 + u24(start + 7) };
    } else if (chunk === 'VP8L') {
      if (image || length < 5 || bytes[start] !== 47) return null;
      image = { width: 1 + (bytes[start + 1] | ((bytes[start + 2] & 63) << 8)), height: 1 + ((bytes[start + 2] >> 6) | (bytes[start + 3] << 2) | ((bytes[start + 4] & 15) << 10)) };
    } else if (chunk === 'VP8 ') {
      if (image || length < 10 || bytes[start + 3] !== 157 || bytes[start + 4] !== 1 || bytes[start + 5] !== 42) return null;
      image = { width: (bytes[start + 6] | (bytes[start + 7] << 8)) & 16383, height: (bytes[start + 8] | (bytes[start + 9] << 8)) & 16383 };
    }
    offset = start + length + (length % 2);
    if (offset > bytes.length) return null;
  }
  return image && (!canvas || (canvas.width === image.width && canvas.height === image.height)) ? image : null;
}

function checkImage(value, resources) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 || ++resources.count > 4) unsafe();
  // 先按编码长度限额，再解码；底图自身像素也有限额，不能用小SVG包装压缩炸弹。
  resources.bytes += match[2].length / 4 * 3 - (match[2].match(/=+$/)?.[0].length || 0);
  if (resources.bytes > POSTER_LIMITS.imageBytes) throw posterError('海报内嵌底图累计超过10MB', 'POSTER_SIZE');
  const bytes = Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0));
  const size = imageDimensions(bytes, match[1]);
  if (!size || size.width <= 0 || size.height <= 0 || size.width > 12000 || size.height > 12000 || size.width * size.height > 25e6)
    throw posterError('海报底图格式与内容不符，或超过2500万像素', 'POSTER_IMAGE');
  resources.pixels += size.width * size.height;
  if (resources.pixels > 25e6) throw posterError('海报内嵌底图累计超过2500万像素', 'POSTER_IMAGE');
}

function checkAttribute(node, key, value, resources) {
  if (!attributes[node.tagName].includes(key)) unsafe();
  if (numberAttributes.has(key)) {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || Math.abs(Number(value)) > 12000) unsafe();
    if (['width', 'height', 'r', 'font-size'].includes(key) && Number(value) <= 0) unsafe();
    if (key === 'fill-opacity' && (Number(value) < 0 || Number(value) > 1)) unsafe();
  } else if (key === 'fill' && !/^(?:#[\da-fA-F]{3}|#[\da-fA-F]{6}|none)$/.test(value)) unsafe();
  else if (key === 'xmlns' && value !== NS) unsafe();
  else if (key === 'href') checkImage(value, resources);
  else if (key === 'preserveAspectRatio' && !['xMidYMid slice', 'xMidYMid meet', 'none'].includes(value)) unsafe();
  else if (key === 'xml:space' && value !== 'preserve') unsafe();
  else if (key === 'text-anchor' && !['start', 'middle', 'end'].includes(value)) unsafe();
  else if (key === 'font-weight' && !/^(?:normal|bold|[1-9]00)$/.test(value)) unsafe();
  else if (key === 'font-family') {
    const families = value.split(',').map(family => family.trim());
    if (families.length > POSTER_FONTS.length + 1 || new Set(families).size !== families.length || !families.every(family => [...POSTER_FONTS, 'sans-serif', 'serif'].includes(family))) unsafe();
  }
}

/** 海报专用白名单，不扩大render_diagram可接受的SVG子集，也不改请求尺寸。 */
export function validatePosterSvg(svg) {
  if (typeof svg !== 'string' || svg.length > POSTER_LIMITS.sourceBytes || new TextEncoder().encode(svg).length > POSTER_LIMITS.sourceBytes)
    throw posterError('海报SVG为空或超过16MB', 'POSTER_SIZE');
  if (/<[!?]|&(?!(?:amp|lt|gt|quot|apos);)|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)) unsafe();
  preflight(svg);
  let doc;
  try { doc = new DOMParser({ onError: unsafe }).parseFromString(svg, 'image/svg+xml'); }
  catch { unsafe(); }
  const root = doc.documentElement;
  if (root?.tagName !== 'svg' || root.namespaceURI !== NS) unsafe();
  const elements = [root, ...Array.from(root.childNodes).filter(node => node.nodeType === 1)];
  if (elements.length > POSTER_LIMITS.nodes) throw posterError('海报元素过多', 'POSTER_SIZE');
  const resources = { count: 0, bytes: 0, pixels: 0 };
  const texts = [], families = new Set();
  for (const node of elements) {
    if (!Object.hasOwn(attributes, node.tagName) || node.namespaceURI !== NS || (node !== root && node.tagName === 'svg')) unsafe();
    for (const child of Array.from(node.childNodes)) {
      if (node === root && child.nodeType === 1) continue;
      if (child.nodeType !== 3 || (node.tagName !== 'text' && child.nodeValue.trim())) unsafe();
    }
    for (const attr of Array.from(node.attributes)) checkAttribute(node, attr.name, attr.value, resources);
    if (node.tagName === 'image' && !node.hasAttribute('href')) unsafe();
    if (node.tagName === 'text') {
      const family = node.getAttribute('font-family');
      if (!family || !family.split(',').some(item => POSTER_FONTS.includes(item.trim()))) unsafe();
      families.add(family);
      texts.push(node.textContent);
    }
  }
  const width = Number(root.getAttribute('width')), height = Number(root.getAttribute('height'));
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= POSTER_LIMITS.side) || width * height > POSTER_LIMITS.pixels)
    throw posterError('海报画布须为整数像素，最长4096且不超过1600万像素', 'POSTER_SIZE');
  if (root.getAttribute('viewBox') !== `0 0 ${width} ${height}`) throw posterError('海报viewBox必须与像素尺寸一致', 'POSTER_SIZE');
  const text = texts.join('');
  if (!text.trim() || text.length > POSTER_LIMITS.text || families.size !== 1) throw posterError('海报文字为空、超过12000字或未统一字体', 'POSTER_TEXT');
  const weights = [...new Set(['400', ...elements.filter(node => node.tagName === 'text').map(node => {
    const value = node.getAttribute('font-weight') || '400';
    return value === 'bold' ? '700' : value === 'normal' ? '400' : value;
  })])];
  return { svg: new XMLSerializer().serializeToString(doc), width, height, text, families: [...families][0].split(',').map(item => item.trim()).filter(item => POSTER_FONTS.includes(item)), weights };
}

export const posterGlyphs = text => [...new Set([...text].filter(ch => !/\s/u.test(ch)))];
// 只改已校验的text起始标签，正文里出现font-family字样时必须原样保留。
export const lockPosterFont = (svg, family) => svg.replace(/<text\b[^>]*>/g, tag => tag.replace(/font-family="[^"]*"/, `font-family="${family}"`));
