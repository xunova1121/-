import { ICON_PNG } from './pptIcons.js';
import { imageData } from './imageRegion.js';
import { sceneElements, validateScene } from './diagramScene.js';

/** 展示版使用同一张PNG；可编辑版逐元素照抄设计坐标，不增加封面、不重新换行。 */
export async function makeDiagramPptx(scene, { png, editable = false } = {}) {
  validateScene(scene);
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  const scale = 13.333333 / scene.width;
  const height = scene.height * scale;
  pptx.defineLayout({ name: 'DIAGRAM', width: 13.333333, height });
  pptx.layout = 'DIAGRAM';
  pptx.author = '未央';
  pptx.subject = editable ? '同一设计稿的原生可编辑图形，需渲染对照验收' : '同一设计稿的展示版，画面来自共享PNG';
  pptx.title = scene.title;
  const slide = pptx.addSlide();
  if (!editable) {
    if (!(png instanceof Blob)) throw Object.assign(new Error('展示版需要实际PNG'), { code: 'DIAGRAM_PPT_PREVIEW', kind: 'input' });
    const image = await imageData(png);
    slide.addImage({ data: `data:${image.mime};base64,${image.data}`, x: 0, y: 0, w: 13.333333, h: height });
  } else {
    const color = (value) => String(value || '#ffffff').replace('#', '');
    for (const item of sceneElements(scene)) {
      if (item.type === 'group') continue;
      if (item.type === 'icon') slide.addImage({ data: 'data:image/png;base64,' + ICON_PNG[item.icon], x: item.x * scale, y: item.y * scale, w: item.width * scale, h: item.height * scale });
      if (item.type === 'rect')
        slide.addShape(item.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
          x: item.x * scale,
          y: item.y * scale,
          w: item.width * scale,
          h: item.height * scale,
          rectRadius: item.radius * scale,
          fill: { color: color(item.fill) },
          line: { color: color(item.stroke || item.fill), width: item.stroke ? item.strokeWidth * scale * 72 : 0 }
        });
      if (item.type === 'text') {
        for (const line of item.lines)
          slide.addText(line.text, {
            x: line.x * scale,
            y: (line.y - item.fontSize * 0.88) * scale,
            w: item.width * scale,
            h: item.fontSize * 1.5 * scale,
            margin: 0,
            fontFace: scene.fontFace,
            fontSize: item.fontSize * scale * 72,
            bold: item.bold,
            color: color(item.fill),
            breakLine: false,
            wrap: false,
            paraSpaceAfterPt: 0,
            lineSpacingMultiple: 1,
            valign: 'top'
          });
      }
      if (item.type === 'path') {
        for (let index = 1; index < item.points.length; index++) {
          const a = item.points[index - 1];
          const b = item.points[index];
          if (a.x === b.x && a.y === b.y) continue;
          const reverse = b.x < a.x || b.y < a.y;
          const arrow = item.arrow && index === item.points.length - 1 ? { [reverse ? 'beginArrowType' : 'endArrowType']: 'triangle' } : {};
          slide.addShape(pptx.ShapeType.line, {
            x: Math.min(a.x, b.x) * scale,
            y: Math.min(a.y, b.y) * scale,
            w: Math.abs(a.x - b.x) * scale,
            h: Math.abs(a.y - b.y) * scale,
            line: { color: color(item.stroke), width: item.strokeWidth * scale * 72, ...arrow }
          });
        }
      }
    }
  }
  const bytes = await pptx.write({ outputType: 'arraybuffer' });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
