/** 只修补本程序刚生成的单页海报固定渐变对象；失败必须报错，不能把纯色块冒充渐变。 */
import { DOMParser } from '@xmldom/xmldom';
import { openOfficePackage } from './officePackage.js';

const TARGET = 'poster-text-gradient';
const SLIDE = 'ppt/slides/slide1.xml';
const invalid = message => Object.assign(new Error(message), { code: 'POSTER_GRADIENT_INVALID', kind: 'validation' });
const children = node => Array.from(node.childNodes).filter(child => child.nodeType === 1);

function gradientXml(color, opacity, mid = null) {
  const alpha = Math.round(opacity * 100000);
  const stop = (position, value) => `<a:gs pos="${position}"><a:srgbClr val="${color}"><a:alpha val="${value}"/></a:srgbClr></a:gs>`;
  const middle = mid ? stop(Math.round(mid.offset * 100000), Math.round(mid.opacity * 100000)) : '';
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stop(0, 0)}${middle}${stop(100000, alpha)}</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
}

/** 只替换spPr的直接子填充，不能误改线条、文字或其他嵌套对象的颜色。 */
function replaceShapeFill(shape, replacement) {
  const properties = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(shape);
  if (!properties) throw invalid('海报渐变对象缺少形状属性');
  const content = properties[1];
  const stack = [];
  let start = -1, end = -1;
  for (const match of content.matchAll(/<(\/?)([A-Za-z][\w:.-]*)\b[^>]*?(\/?)>/g)) {
    const closing = match[1] === '/', selfClosing = match[3] === '/';
    if (closing) {
      if (stack.pop() !== match[2]) throw invalid('海报渐变对象结构无效');
      if (match[2] === 'a:solidFill' && !stack.length && start >= 0) end = match.index + match[0].length;
    } else {
      if (!stack.length && match[2] === 'a:solidFill') {
        if (start >= 0) throw invalid('海报渐变对象含多个填充');
        start = match.index;
        if (selfClosing) end = match.index + match[0].length;
      }
      if (!selfClosing) stack.push(match[2]);
    }
  }
  if (stack.length || start < 0 || end <= start) throw invalid('海报渐变对象没有唯一的原始纯色填充');
  const changed = content.slice(0, start) + replacement + content.slice(end);
  return shape.replace(properties[0], properties[0].replace(content, () => changed));
}

function rewriteSlide(xml, color, opacity, mid = null) {
  if (xml.length > 1e6 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('海报页面结构超出限制');
  let doc;
  try { doc = new DOMParser({ onError: () => { throw invalid('海报页面XML无效'); } }).parseFromString(xml, 'application/xml'); }
  catch { throw invalid('海报页面XML无效'); }
  if (doc.documentElement?.tagName !== 'p:sld') throw invalid('海报页面格式无效');
  const targets = Array.from(doc.getElementsByTagName('p:cNvPr')).filter(node => node.getAttribute('name') === TARGET);
  if (targets.length !== 1) throw invalid('海报PPT必须有唯一的固定渐变对象');
  const shapeNode = targets[0].parentNode?.parentNode;
  if (shapeNode?.tagName !== 'p:sp') throw invalid('海报渐变目标不是独立形状');
  const properties = children(shapeNode).filter(node => node.tagName === 'p:spPr');
  const fills = properties.length === 1 ? children(properties[0]).filter(node => /^a:(?:solidFill|gradFill|noFill|blipFill|pattFill|grpFill)$/.test(node.tagName)) : [];
  if (fills.length !== 1 || fills[0].tagName !== 'a:solidFill') throw invalid('海报渐变目标必须有唯一原始纯色填充');
  let count = 0;
  const output = xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g, shape => {
    const name = /<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(shape)?.[1];
    if (name !== TARGET) return shape;
    count++;
    return replaceShapeFill(shape, gradientXml(color, opacity, mid));
  });
  if (count !== 1 || output === xml) throw invalid('海报PPT渐变没有准确写入');
  return output;
}

/** 原生透明渐变从上到下，0%完全透明至100%指定不透明度；其他ZIP部件内容逐字节保留。 */
export async function applyPosterGradient(blob, { color, opacity = 0.85, mid = null } = {}) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > 20e6 || typeof color !== 'string' || !/^#?[\da-f]{6}$/i.test(color) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw invalid('海报PPT渐变参数无效');
  const normalized = color.replace(/^#/, '').toUpperCase();
  try {
    const zip = await openOfficePackage(blob);
    const entries = Object.values(zip.files);
    if (entries.length > 256 || entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0) > 40e6)
      throw invalid('单页海报PPT展开内容超出限制');
    const slides = entries.filter(entry => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
    if (slides.length !== 1 || slides[0].name !== SLIDE || slides[0]._data?.uncompressedSize > 1e6)
      throw invalid('海报渐变仅支持本程序生成的单页PPT');
    const source = await slides[0].async('string');
    zip.file(SLIDE, rewriteSlide(source, normalized, opacity, mid));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    if (bytes.byteLength > 20e6) throw invalid('海报PPT渐变输出超过大小限制');
    return new Blob([bytes], { type: blob.type || 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  } catch (error) {
    if (error?.code === 'POSTER_GRADIENT_INVALID') throw error;
    throw invalid('海报PPT渐变写入失败，未退回纯色块');
  }
}
