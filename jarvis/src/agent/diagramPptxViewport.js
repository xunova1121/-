import { sceneSvg } from './diagramSceneSvg.js';
import { validateSvg } from './svgPreview.js';

export const diagramInchesPerPixel = scene => scene.fontFace === 'Noto Sans CJK SC' ? 1 / 96 : 13.333333 / scene.width;

/** 同SVG真实整数视口的xMidYMid meet；只平移完整设计，不裁剪、改字或改原稿。 */
export function diagramPptxViewport(scene) {
  if (scene.fontFace !== 'Noto Sans CJK SC') return { scene, scale: diagramInchesPerPixel(scene) };
  const viewport = validateSvg(sceneSvg(scene));
  const factor = Math.min(viewport.width / scene.width, viewport.height / scene.height);
  // 浮点除法不得产生比原画布略小的边界，避免把背景坐标变成负epsilon。
  const width = Math.max(scene.width, viewport.width / factor);
  const height = Math.max(scene.height, viewport.height / factor);
  const dx = (width - scene.width) / 2, dy = (height - scene.height) / 2;
  if (Math.max(width, height) / 96 > 56)
    throw Object.assign(new Error('原生PPT画布超过56英寸，请拆分总体与专题；原设计和图片保留，不缩字或裁图'), { code: 'DIAGRAM_PPTX_PAGE_SIZE', kind: 'input' });
  const shift = item => ({
    ...item,
    ...(Number.isFinite(item.x) && { x: item.x + dx }),
    ...(Number.isFinite(item.y) && { y: item.y + dy }),
    ...(item.bounds && { bounds: { ...item.bounds, x: item.bounds.x + dx, y: item.bounds.y + dy } }),
    ...(item.points && { points: item.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy })) }),
    ...(item.lines && { lines: item.lines.map(line => ({ ...line, x: line.x + dx, y: line.y + dy })) }),
    ...(item.children && { children: item.children.map(shift) })
  });
  const copy = structuredClone(scene);
  copy.elements = copy.elements.map(shift);
  copy.width = width; copy.height = height;
  return { scene: copy, scale: diagramInchesPerPixel(copy), viewport: { width: viewport.width, height: viewport.height, factor, dx, dy } };
}
