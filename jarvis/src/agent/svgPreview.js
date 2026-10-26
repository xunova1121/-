import { throwControl } from '../core/networkRequest.js';

const fail = (text, code = 'SVG_INPUT') => Object.assign(new Error(text), { code, kind: 'input' });
const tags = new Set(
  'svg g defs marker path rect text tspan line polyline polygon circle ellipse title desc linearGradient radialGradient stop clipPath'.toLowerCase().split(' ')
);

/** 只渲染自包含的静态矢量子集；不加载脚本、外部字体/图片、CSS或XML实体。 */
export function validateSvg(svg) {
  if (typeof svg !== 'string' || new TextEncoder().encode(svg).length > 2e6) throw fail('SVG超过2MB或内容无效');
  if (/<[^>]*(?:\\|\bstyle\s*=)/i.test(svg)) throw fail('SVG不支持CSS样式或属性转义，请使用静态绘图属性', 'SVG_UNSAFE');
  if (
    /<!DOCTYPE|<!ENTITY|<!\[CDATA|<\?(?!xml\s)|\bxml:base\s*=|\bon\w+\s*=|(?:href|src)\s*=|(?:@import|url\s*\(\s*(?!#[\w-]+\s*\)))|&(?!(?:amp|lt|gt|quot|apos);)/i.test(
      svg
    )
  )
    throw fail('SVG包含不支持的外部资源或活动内容', 'SVG_UNSAFE');
  const clean = svg
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const root = clean.match(/^<svg\b([^>]*)>/i);
  if (!root || !/<\/svg>\s*$/i.test(clean)) throw fail('不是完整SVG文件');
  let count = 0;
  for (const match of clean.matchAll(/<\/?([\w:-]+)\b/g)) {
    if (++count > 10000 || !tags.has(match[1].toLowerCase())) throw fail('SVG含不支持的元素或节点过多', 'SVG_UNSAFE');
  }
  const dimension = (key) => Number(root[1].match(new RegExp(`\\b${key}=["']([\\d.]+)(?:px)?["']`, 'i'))?.[1]);
  const view = root[1]
    .match(/\bviewBox=["']\s*([\d.e+\-\s,]+)["']/i)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = dimension('width') || view?.[2];
  const height = dimension('height') || view?.[3];
  if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 12000) || width * height > 25e6)
    throw fail('SVG画布尺寸无效或超过2500万像素');
  const scale = Math.min(1.5, 2048 / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  let attributes = root[1].replace(/\b(?:width|height)=["'][^"']*["']/gi, '');
  if (!view) attributes += ` viewBox="0 0 ${width} ${height}"`;
  const normalized = clean.replace(root[0], `<svg${attributes} width="${targetWidth}" height="${targetHeight}">`);
  return { svg: normalized, width: targetWidth, height: targetHeight };
}

/** 浏览器/安卓在本机Canvas渲染真实PNG；最长15秒，停止立即解除图片等待。 */
export async function renderSvg(svg, { signal } = {}) {
  const checked = validateSvg(svg);
  throwControl(null, signal);
  if (typeof document === 'undefined' || typeof Image === 'undefined')
    throw Object.assign(new Error('当前环境未提供SVG渲染器'), { code: 'SVG_RENDER_UNAVAILABLE', kind: 'capability' });
  const img = new Image();
  const src = URL.createObjectURL(new Blob([checked.svg], { type: 'image/svg+xml' }));
  let timer;
  let abort;
  const canvas = document.createElement('canvas');
  try {
    await new Promise((resolve, reject) => {
      abort = () => {
        img.src = '';
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      timer = setTimeout(() => reject(Object.assign(new Error('SVG渲染超时'), { code: 'SVG_RENDER_TIMEOUT', kind: 'timeout' })), 15000);
      signal?.addEventListener('abort', abort, { once: true });
      img.onload = resolve;
      img.onerror = () => reject(fail('SVG无法解码', 'SVG_RENDER'));
      img.src = src;
      if (signal?.aborted) abort();
    });
    canvas.width = checked.width;
    canvas.height = checked.height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    throwControl(null, signal);
    if (!blob || blob.size > 12e6) throw fail('PNG渲染为空或超过12MB', 'SVG_RENDER');
    return blob;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    img.src = '';
    URL.revokeObjectURL(src);
    canvas.width = canvas.height = 0;
  }
}
