/** 在实际观看宽度下检查字号；像素够大、对比够高不代表整张缩到手机后能读。 */
import { fitDesignText } from './layeredDesignInput.js';
import { chartLabelNodes } from './layeredDesignSvg.js';

const MINIMUM = { heading: 18, body: 12, label: 8.5, caption: 7 };
function textRole(node, design) {
  // 页脚、序号可小一些；大段正文不能仅凭role=caption逃避检查。
  if (/^(?:footer|source|asof)(?:-|$)/i.test(node.id) && node.y >= design.height * 0.85) return 'caption';
  if (node.id === 'title') return 'heading';
  if (/(?:^|[-_])(?:body|title|value|copy)(?:-|$)/i.test(node.id)) return 'body';
  if (node.role === 'caption' && node.text.length > 24 || node.role === 'label' && node.text.length > 100) return 'body';
  if (node.role) return node.role;
  return /(?:^eyebrow$|-(?:label|category|meta)$)/.test(node.id) ? 'label' : 'body';
}

/** 缩放整张原构图，而非另排可读卡片来掩盖原海报的小字；原SVG白名单保持不变。 */
export function phonePreviewSvg(svg, design) {
  const width = Math.min(390, design.width), scale = width / design.width;
  const height = Math.ceil(design.height * scale);
  const root = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  return { width, height, svg: svg.replace(/^<svg\b[^>]*>/, root + `<g transform="scale(${scale})">`).replace(/<\/svg>$/, '</g></svg>') };
}
export function checkDesignPresentation(design) {
  if (!design.reading) return { status: 'not_checked', reason: '旧稿未声明阅读场景；重新构图可补手机整图检查' };
  const previewWidth = Math.min(design.width, design.reading === 'phone' ? 390 : 1440), scale = previewWidth / design.width;
  const failed = [], bodySizes = [];
  const text = design.layers.flatMap(n => n.type === 'text' ? [n] : n.type === 'chart' ? chartLabelNodes(n).map(label => ({ ...label, role: 'label' })) : []).filter(n => n.text.trim());
  for (const node of text) {
    const role = textRole(node, design), size = fitDesignText(node).fontSize * scale, minimum = MINIMUM[role];
    if (role === 'body') bodySizes.push(size);
    if (size + 0.01 < minimum) failed.push({ id: node.id, role, pixels: Math.round(size * 100) / 100, minimum });
  }
  const groups = new Set(design.layers.filter(n => n.type === 'text' && textRole(n, design) === 'body').map(n => n.group));
  const heroShare = Math.max(0, ...design.layers.filter(n => n.type === 'image').map(n => n.w * n.h / (design.width * design.height)));
  const body = text.filter(n => textRole(n, design) === 'body');
  const separateHero = design.layers.filter(n => n.type === 'image' && !body.some(t => Math.min(t.x + t.w, n.x + n.w) > Math.max(t.x, n.x) && Math.min(t.y + t.h, n.y + n.h) > Math.max(t.y, n.y)));
  const separateShare = Math.max(0, ...separateHero.map(n => n.w * n.h / (design.width * design.height)));
  if (design.reading === 'phone' && groups.size >= 5 && separateShare > 0.45) failed.push({ id: 'composition', reason: '多栏目正文被大幅独占主视觉挤压，主视觉占比超过45%' });
  return { status: failed.length ? 'failed' : 'passed', target: design.reading, previewWidth,
    minimumBodyPixels: bodySizes.length ? Math.round(Math.min(...bodySizes) * 100) / 100 : null,
    heroShare: Math.round(heroShare * 1000) / 1000, failed: failed.slice(0, 10),
    basis: '整图按此宽度显示的几何字号检查；不证明审美、事实准确或真实手机显示均通过' };
}
