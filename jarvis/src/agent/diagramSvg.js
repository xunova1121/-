import { diagramText as textBlock, diagramLines, escapeSvg } from './diagramText.js';
import { diagramRoutes } from './diagramRoutes.js';

export function diagramSvg(model) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${escapeSvg(model.title)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#8291ad"/></marker></defs><rect width="100%" height="100%" fill="#ffffff"/>`];
  parts.push(textBlock(model.title, 48, 54, 1344, 30, 2, '#172a49', 700));
  for (const layer of model.layers) {
    parts.push(`<g data-layer="${escapeSvg(layer.title)}"><rect x="48" y="${layer.y}" width="1344" height="${layer.height}" rx="12" fill="${layer.emphasis ? '#f0f5fc' : '#fafbfd'}" stroke="${layer.emphasis ? '#b2c7e1' : '#e2e8ef'}" stroke-width="${layer.emphasis ? 2 : 1}"/>`);
    const [heading, ...captions] = layer.title.split(/\s*[|｜·]\s*/);
    const caption = captions.join(' · ');
    const headingLines = diagramLines(heading, 150 / 18, caption ? 2 : 3).length;
    parts.push(textBlock(heading, 72, layer.y + 36, 150, 18, caption ? 2 : 3, '#334c72', 600));
    if (caption) parts.push(textBlock(caption, 72, layer.y + 62 + (headingLines - 1) * 25.2, 150, 13, 2, '#64748b'));
    for (const node of layer.nodes) {
      parts.push(`<g id="node-${escapeSvg(node.id)}"><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="${layer.emphasis ? '#173f70' : '#ffffff'}"/>`);
      parts.push(textBlock(node.title, node.x + 18, node.y + 30, node.width - 36, 20, 2, layer.emphasis ? '#fff' : '#223754', 600));
      if (node.detail) parts.push(textBlock(node.detail, node.x + 18, node.y + 30 + diagramLines(node.title, (node.width - 36) / 20, 2).length * 28 + 4, node.width - 36, 15, 3, layer.emphasis ? '#d9e6f5' : '#536781'));
      parts.push('</g>');
    }
    parts.push('</g>');
  }
  for (const edge of diagramRoutes(model)) {
    parts.push(`<path d="${edge.path}" fill="none" stroke="#8291ad" stroke-width="1.6" marker-end="url(#arrow)" data-from="${escapeSvg(edge.from)}" data-to="${escapeSvg(edge.to)}"/>`);
  }
  if (!model.edges.length) {
    // 总体架构未给节点级边时只表达层间支撑，避免无依据绘制全连接网。
    for (let index = 1; index < model.layers.length; index++) {
      const upper = model.layers[index - 1];
      const lower = model.layers[index];
      parts.push(`<path d="M804,${lower.y - 4} L804,${upper.y + upper.height + 6}" fill="none" stroke="#8291ad" stroke-width="1.6" marker-end="url(#arrow)"/>`);
      parts.push(textBlock('支撑', 822, lower.y - 12, 80, 12, 1, '#64748b'));
    }
  }
  parts.push('</svg>');
  return parts.join('');
}
