/** 视觉场景独立静态白名单；不扩大通用SVG或海报原有安全边界。 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { POSTER_FONTS } from './posterSvg.js';
import { normalizePosterBackground } from './posterCompositionInput.js';
import { VISUAL_LIMITS, visualError } from './visualSceneInput.js';

const NS = 'http://www.w3.org/2000/svg';
const common = ['id', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', 'data-viz', 'data-index', 'data-label'];
const attrs = Object.fromEntries(Object.entries({
  svg: ['xmlns', 'width', 'height', 'viewBox'],
  g: [], defs: [],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'], path: ['d'], polyline: ['points'], polygon: ['points'],
  text: ['x', 'y', 'dx', 'dy', 'font-size', 'font-family', 'font-weight', 'letter-spacing', 'text-anchor', 'xml:space'],
  tspan: ['x', 'y', 'dx', 'dy', 'font-size', 'font-family', 'font-weight', 'letter-spacing', 'text-anchor', 'xml:space'],
  image: ['x', 'y', 'width', 'height', 'href', 'preserveAspectRatio'],
  linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits'],
  stop: ['offset', 'stop-color', 'stop-opacity'], title: [], desc: []
}).map(([key, values]) => [key, new Set([...values, ...common])]));
const numeric = new Set(['x', 'y', 'dx', 'dy', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'font-size', 'letter-spacing', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity']);
const positive = new Set(['width', 'height', 'r', 'rx', 'ry', 'font-size']);
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numberRegex = new RegExp('^' + numberPattern + '$');
const numbersRegex = new RegExp(numberPattern, 'g');
const unsafe = () => { throw visualError('视觉图仅接受受限静态图形、字体文字及内嵌位图', 'VISUAL_SVG_UNSAFE'); };
const isGradient = tag => tag === 'linearGradient' || tag === 'radialGradient';

function number(value, maximum = 12000) {
  if (!numberRegex.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > maximum) unsafe();
  return Number(value);
}

function numberList(value, limit = 80000) {
  const list = value.match(numbersRegex) || [];
  if (!list.length || list.length > limit || value.replace(numbersRegex, '').replace(/[\s,]/g, '')) unsafe();
  return list.map(item => number(item));
}

/** DOM解析前限制层级、元素和属性，避免恶意XML先分配无界树。 */
function preflight(svg) {
  const stack = [];
  let offset = 0, count = 0;
  while ((offset = svg.indexOf('<', offset)) !== -1) {
    const start = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(svg.slice(offset));
    if (!start || !Object.hasOwn(attrs, start[2]) || ++count > VISUAL_LIMITS.nodes * 2) unsafe();
    offset += start[0].length;
    if (start[1]) {
      const end = /^\s*>/.exec(svg.slice(offset));
      if (!end || stack.pop() !== start[2]) unsafe();
      offset += end[0].length;
      continue;
    }
    if (stack.length > 10 || !stack.length && start[2] !== 'svg' || stack.length && start[2] === 'svg') unsafe();
    const seen = new Set();
    let selfClosing = false;
    while (true) {
      const end = /^\s*(\/?)>/.exec(svg.slice(offset));
      if (end) { selfClosing = Boolean(end[1]); offset += end[0].length; break; }
      const attribute = /^\s+([A-Za-z_:][\w:.-]*)\s*=\s*(["'])/.exec(svg.slice(offset));
      if (!attribute || !attrs[start[2]].has(attribute[1]) || seen.has(attribute[1])) unsafe();
      seen.add(attribute[1]);
      offset += attribute[0].length;
      const finish = svg.indexOf(attribute[2], offset);
      const maximum = attribute[1] === 'href' ? 14e6 : ['d', 'points'].includes(attribute[1]) ? 500000 : 512;
      if (finish < 0 || finish - offset > maximum || svg.indexOf('<', offset) >= 0 && svg.indexOf('<', offset) < finish) unsafe();
      offset = finish + 1;
    }
    if (!selfClosing) stack.push(start[2]);
  }
  if (stack.length) unsafe();
}

function checkTransform(value) {
  let count = 0;
  const remaining = value.replace(/(translate|scale|rotate)\(([^()]*)\)/g, (_all, type, content) => {
    if (++count > 6) unsafe();
    const values = numberList(content, 3);
    if (type === 'rotate' ? ![1, 3].includes(values.length) : ![1, 2].includes(values.length)) unsafe();
    if (type === 'scale' && values.some(item => item <= 0 || item > 64)) unsafe();
    return '';
  });
  if (!count || remaining.trim()) unsafe();
}

function checkImage(value, resources) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 || ++resources.count > 4) unsafe();
  const bytes = match[2].length / 4 * 3 - (match[2].match(/=+$/)?.[0].length || 0);
  if ((resources.bytes += bytes) > 10e6) throw visualError('视觉场景内嵌位图累计超过10MB', 'VISUAL_SVG_SIZE');
  let checked;
  try { checked = normalizePosterBackground({ bytes: Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0)), mime: 'image/' + match[1] }); }
  catch { unsafe(); }
  resources.pixels += checked.width * checked.height;
  if (resources.pixels > 25e6) throw visualError('视觉场景内嵌位图累计超过2500万像素', 'VISUAL_SVG_SIZE');
}

function checkAttribute(node, key, value, resources, references) {
  if (!attrs[node.tagName].has(key)) unsafe();
  if (numeric.has(key)) {
    const actual = number(value);
    if (positive.has(key) && actual <= 0 || key === 'stroke-width' && actual < 0 || key.endsWith('opacity') && (actual < 0 || actual > 1)) unsafe();
  } else if (['fill', 'stroke', 'stop-color'].includes(key)) {
    const reference = /^url\(#([A-Za-z][\w-]{0,63})\)$/.exec(value);
    if (reference && key !== 'stop-color') references.push(reference[1]);
    else if (!/^(?:#[\da-fA-F]{3}|#[\da-fA-F]{6}|none)$/.test(value)) unsafe();
  } else if (key === 'xmlns' && (node.tagName !== 'svg' || value !== NS)) unsafe();
  else if (key === 'id' && !/^[A-Za-z][\w-]{0,63}$/.test(value)) unsafe();
  else if (key === 'href') checkImage(value, resources);
  else if (key === 'preserveAspectRatio' && !['xMidYMid slice', 'xMidYMid meet', 'none'].includes(value)) unsafe();
  else if (key === 'xml:space' && value !== 'preserve') unsafe();
  else if (key === 'text-anchor' && !['start', 'middle', 'end'].includes(value)) unsafe();
  else if (key === 'font-weight' && !/^(?:normal|bold|[1-9]00)$/.test(value)) unsafe();
  else if (key === 'font-family') {
    const families = value.split(',').map(item => item.trim());
    if (families.length > POSTER_FONTS.length + 2 || new Set(families).size !== families.length || !families.every(item => [...POSTER_FONTS, 'serif', 'sans-serif'].includes(item))) unsafe();
  } else if (key === 'stroke-linecap' && !['butt', 'round', 'square'].includes(value)) unsafe();
  else if (key === 'stroke-linejoin' && !['miter', 'round', 'bevel'].includes(value)) unsafe();
  else if (key === 'stroke-dasharray' && numberList(value, 16).some(item => item < 0)) unsafe();
  else if (key === 'gradientUnits' && !['objectBoundingBox', 'userSpaceOnUse'].includes(value)) unsafe();
  else if (key === 'offset') {
    const percent = value.endsWith('%'), actual = number(percent ? value.slice(0, -1) : value);
    if (actual < 0 || actual > (percent ? 100 : 1)) unsafe();
  } else if (key === 'transform') checkTransform(value);
  else if (key === 'points' && numberList(value).length % 2) unsafe();
  else if (key === 'd') {
    if (!/^[Mm]/.test(value) || value.replace(/[MmZzLlHhVvCcSsQqTtAa]/g, '').replace(numbersRegex, '').replace(/[\s,]/g, '')) unsafe();
    const numbers = value.match(numbersRegex) || [];
    if (numbers.length > 80000) unsafe();
    numbers.forEach(item => number(item));
  } else if (key === 'data-viz' && !['metric', 'series-point', 'marker', 'alert', 'time-label', 'radar', 'grid'].includes(value)) unsafe();
  else if (key === 'data-index' && !/^\d{1,3}$/.test(value)) unsafe();
  else if (key === 'data-label' && value.length > 160) unsafe();
}

export function validateVisualSceneSvg(svg) {
  if (typeof svg !== 'string' || !svg || svg.length > VISUAL_LIMITS.bytes || new TextEncoder().encode(svg).length > VISUAL_LIMITS.bytes) throw visualError('视觉SVG为空或超过16MB', 'VISUAL_SVG_SIZE');
  if (/<[!?]|&(?!(?:amp|lt|gt|quot|apos);)|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)) unsafe();
  preflight(svg);
  let doc;
  try { doc = new DOMParser({ onError: unsafe }).parseFromString(svg, 'image/svg+xml'); } catch { unsafe(); }
  const root = doc.documentElement;
  if (root?.tagName !== 'svg' || root.namespaceURI !== NS) unsafe();
  const elements = [root, ...Array.from(root.getElementsByTagName('*'))];
  if (elements.length > VISUAL_LIMITS.nodes) throw visualError('视觉SVG元素超过6000个', 'VISUAL_SVG_SIZE');
  const ids = new Map(), references = [], resources = { bytes: 0, pixels: 0, count: 0 }, texts = [], families = new Set(), weights = new Set(['400']);
  for (const node of elements) {
    if (!Object.hasOwn(attrs, node.tagName) || node.namespaceURI !== NS) unsafe();
    const id = node.getAttribute('id');
    if (id) { if (ids.has(id)) unsafe(); ids.set(id, node.tagName); }
    for (const attribute of Array.from(node.attributes)) checkAttribute(node, attribute.name, attribute.value, resources, references);
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        const allowed = ['svg', 'g', 'defs'].includes(node.tagName) || isGradient(node.tagName) && child.tagName === 'stop' || node.tagName === 'text' && child.tagName === 'tspan';
        if (!allowed) unsafe();
      } else if (child.nodeType !== 3 || !['text', 'tspan', 'title', 'desc'].includes(node.tagName) && child.nodeValue.trim()) unsafe();
    }
    if (node.tagName === 'image' && !node.hasAttribute('href')) unsafe();
    if (['text', 'tspan'].includes(node.tagName)) {
      // 字体锁定只修改text起始标签，因此子tspan不可覆写字体或字重。
      if (node.tagName === 'tspan') {
        if (node.hasAttribute('font-family') || node.hasAttribute('font-weight')) unsafe();
        continue;
      }
      const family = node.getAttribute('font-family');
      if (!family || !family.split(',').some(item => POSTER_FONTS.includes(item.trim()))) unsafe();
      families.add(family.split(',').map(item => item.trim()).join(','));
      texts.push(node.textContent);
      const weight = node.getAttribute('font-weight') || '400';
      weights.add(weight === 'bold' ? '700' : weight === 'normal' ? '400' : weight);
    }
  }
  if (references.some(id => !isGradient(ids.get(id)))) unsafe();
  const width = Number(root.getAttribute('width')), height = Number(root.getAttribute('height'));
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= VISUAL_LIMITS.side) || width * height > VISUAL_LIMITS.pixels || root.getAttribute('viewBox') !== `0 0 ${width} ${height}`) throw visualError('视觉SVG需使用原尺寸整数像素viewBox，最长4096且不超过1600万像素', 'VISUAL_SVG_SIZE');
  const text = texts.join('');
  if (!text.trim() || text.length > VISUAL_LIMITS.text || families.size !== 1) throw visualError('视觉SVG需有统一字体的文字，全文不超过16000字', 'VISUAL_SVG_TEXT');
  return { svg: new XMLSerializer().serializeToString(doc), width, height, text, families: [...families][0].split(',').filter(item => POSTER_FONTS.includes(item)), weights: [...weights] };
}
