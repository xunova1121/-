import { DIAGRAM_ICON_ASSETS } from './diagramIconAssets.js';
import { escapeSvg } from './diagramText.js';
import { validateScene, sceneElements } from './diagramScene.js';

/** SVG只是设计稿的序列化器，不再自行计算文字位置或连接线。 */
export function sceneSvg(scene) {
  validateScene(scene);
  const draw = (item) => {
    if (item.type === 'group')
      return `<g${item.nodeId ? ` id="node-${escapeSvg(item.nodeId)}"` : ''}${item.layer ? ` data-layer="${escapeSvg(item.layer)}"` : ''}>${item.children.map(draw).join('')}</g>`;
    if (item.type === 'icon') return `<g transform="translate(${item.x} ${item.y}) scale(${item.width / 24})" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${DIAGRAM_ICON_ASSETS[item.icon]}</g>`;
    if (item.type === 'rect')
      return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="${item.radius}" fill="${escapeSvg(item.fill)}"${item.stroke ? ` stroke="${escapeSvg(item.stroke)}" stroke-width="${item.strokeWidth}"` : ''}/>`;
    if (item.type === 'text')
      return `<text font-size="${item.fontSize}" font-weight="${item.bold ? 600 : 400}" fill="${escapeSvg(item.fill)}">${item.lines.map((line) => `<tspan x="${line.x}" y="${line.y}">${escapeSvg(line.text)}</tspan>`).join('')}</text>`;
    const route = item.points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
    return `<path d="${route}" fill="none" stroke="${escapeSvg(item.stroke)}" stroke-width="${item.strokeWidth}"${item.dash ? ` stroke-dasharray="${item.dash==='dash'?'6 4':'2 4'}"` : ''}${item.arrow ? ` marker-end="url(#arrow-${item.stroke.slice(1)})"` : ''}${item.from ? ` data-from="${escapeSvg(item.from)}" data-to="${escapeSvg(item.to)}"` : ''}/>`;
  };
  const strokes = [...new Set(sceneElements(scene).filter(item => item.type === 'path' && item.arrow).map(item => item.stroke))];
  const markers = strokes.map(stroke => `<marker id="arrow-${stroke.slice(1)}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="${stroke}"/></marker>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${escapeSvg(scene.title)}" font-family="${escapeSvg(scene.fontFamily)}"><defs>${markers}</defs>${scene.elements.map(draw).join('')}</svg>`;
}
