import { nativeTree, nativeLeaves, groupNativeDiagram } from './diagramPptxStructure.js';
import { ICON_PNG } from './pptIcons.js';
import { imageData } from './imageRegion.js';
import { validateScene } from './diagramScene.js';

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
  let diagramTree;
  if (!editable) {
    if (!(png instanceof Blob)) throw Object.assign(new Error('展示版需要实际PNG'), { code: 'DIAGRAM_PPT_PREVIEW', kind: 'input' });
    const image = await imageData(png);
    slide.addImage({ data: `data:${image.mime};base64,${image.data}`, x: 0, y: 0, w: 13.333333, h: height });
  } else {
    const tree = nativeTree(scene);
    diagramTree = tree;
    let objectCount = 0;
    const color = (value) => String(value || '#ffffff').replace('#', '');
    for (const record of nativeLeaves(tree)) {
      const item = record.item;
      const objectName = () => {
        if (++objectCount > 8000) throw Object.assign(new Error('原生对象超过8000，请拆图'), { code: 'DIAGRAM_PPTX_SIZE', kind: 'input' });
        const key = record.key + '-' + record.keys.length;
        record.keys.push(key);
        return key;
      };
      if (item.type === 'group') continue;
      if (item.type === 'icon')
        slide.addImage({
          objectName: objectName(),
          data: 'data:image/png;base64,' + ICON_PNG[item.icon],
          x: item.x * scale,
          y: item.y * scale,
          w: item.width * scale,
          h: item.height * scale
        });
      if (item.type === 'rect')
        slide.addShape(item.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
          objectName: objectName(),
          x: item.x * scale,
          y: item.y * scale,
          w: item.width * scale,
          h: item.height * scale,
          rectRadius: item.radius * scale,
          fill: { color: color(item.fill) },
          line: item.stroke ? { color: color(item.stroke), width: item.strokeWidth * scale * 72 } : { type: 'none' }
        });
      if (item.type === 'text') {
        for (const line of item.lines)
          slide.addText(line.text, {
            objectName: objectName(),
            x: line.x * scale,
            y: (line.y - item.fontSize * (scene.fontFace === 'Noto Sans CJK SC' ? 0.98 : 1)) * scale,
            w: item.width * scale,
            h: item.fontSize * 1.5 * scale,
            margin: 0,
            fontFace: scene.fontFace,
            lang: 'zh-CN',
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
        const xs = item.points.map((point) => point.x),
          ys = item.points.map((point) => point.y);
        const x = Math.min(...xs),
          y = Math.min(...ys),
          w = Math.max(...xs) - x,
          h = Math.max(...ys) - y;
        const straight = item.points.length === 2;
        const first = item.points[0],
          last = item.points.at(-1);
        slide.addShape(straight ? pptx.ShapeType.line : pptx.ShapeType.custGeom, {
          objectName: objectName(),
          x: x * scale,
          y: y * scale,
          w: Math.max(w * scale, 0.001),
          h: Math.max(h * scale, 0.001),
          ...(straight
            ? { flipH: last.x < first.x, flipV: last.y < first.y }
            : { points: item.points.map((point) => ({ x: (point.x - x) * scale, y: (point.y - y) * scale })) }),
          fill: { color: color(item.stroke), transparency: 100 },
          line: {
            color: color(item.stroke),
            width: item.strokeWidth * scale * 72,
            ...(item.dash && { dashType: item.dash === 'dash' ? 'dash' : 'sysDot' }),
            ...(item.arrow && { endArrowType: 'triangle' })
          }
        });
      }
    }
  }
  let bytes = await pptx.write({ outputType: 'arraybuffer' });
  if (editable) bytes = await groupNativeDiagram(bytes, scene, diagramTree);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
