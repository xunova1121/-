/** 文本、卡片、折线均为原生可编辑对象；图标独立矢量对象，原图独立图片对象。 */
import { fitDesignText } from './layeredDesignInput.js';
import { chartGeometry, chartLabelNodes, designIconMarkup } from './layeredDesignSvg.js';
import { barChartGeometry } from './posterBarChart.js';

const inch = px => px / 96;
function dataSvg(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'image/svg+xml;base64,' + btoa(binary);
}
function text(slide, node, font = 'Noto Sans CJK SC') {
  const fit = fitDesignText(node);
  fit.rows.forEach((row, i) => slide.addText(row, {
    x: inch(node.x), y: inch(node.y + i * fit.lineHeight), w: inch(node.w), h: inch(fit.lineHeight),
    fontSize: fit.fontSize * 0.75, fontFace: font, bold: node.weight === 700,
    color: node.color.slice(1), margin: 0, align: node.align, valign: 'top', wrap: false,
    paraSpaceAfterPt: 0, paraSpaceBeforePt: 0, lang: 'zh-CN', objectName: `layer-${node.id}-${i}`
  }));
}
function chart(pptx, slide, node, font) {
  if (node.chartType === 'bar') {
    const g = barChartGeometry(node);
    slide.addShape(pptx.ShapeType.line, { x: inch(g.zero), y: inch(node.y), w: 0, h: inch(node.h), line: { color: node.color.slice(1), width: 1 }, objectName: `layer-${node.id}-zero` });
    g.bars.filter(b => b.w > 0).forEach((b, i) => slide.addShape(pptx.ShapeType.rect, { x: inch(b.x), y: inch(b.y), w: inch(b.w), h: inch(b.h), fill: { color: node.color.slice(1) }, line: { transparency: 100 }, objectName: `layer-${node.id}-bar-${i}` }));
    g.labels.forEach(label => text(slide, label, font));
    return;
  }
  const g = chartGeometry(node);
  // 用可编辑线段和数据标签，而不是把整张图表烘焙成一张图片。
  for (let i = 1; i < g.points.length; i++) {
    const a = g.points[i - 1], b = g.points[i];
    slide.addShape(pptx.ShapeType.line, { x: inch(Math.min(a.x, b.x)), y: inch(Math.min(a.y, b.y)), w: inch(Math.abs(b.x - a.x)), h: inch(Math.abs(b.y - a.y)),
      flipV: b.y < a.y, line: { color: node.color.slice(1), width: Math.max(1, node.w / 600) }, objectName: `layer-${node.id}-segment-${i}` });
  }
  for (const p of g.points) slide.addShape(pptx.ShapeType.ellipse, { x: inch(p.x - 3), y: inch(p.y - 3), w: inch(6), h: inch(6), fill: { color: node.color.slice(1) }, line: { transparency: 100 }, objectName: `layer-${node.id}-point` });
  chartLabelNodes(node).forEach(label => text(slide, label, font));
}
export async function composeLayeredPptx(design, assets) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LAYERED_PIXELS', width: inch(design.width), height: inch(design.height) });
  pptx.layout = 'LAYERED_PIXELS'; pptx.title = design.title; pptx.author = '未央'; pptx.lang = 'zh-CN';
  pptx.subject = '同源分层设计；文字/形状/线段可编辑；图标为独立矢量对象；字体不嵌入';
  const slide = pptx.addSlide(); slide.background = { color: design.palette.background.slice(1) };
  const font = design.fontFamily === 'serif' ? 'Noto Serif CJK SC' : 'Noto Sans CJK SC';
  for (const node of design.layers) {
    const box = { x: inch(node.x), y: inch(node.y), w: inch(node.w), h: inch(node.h), objectName: `layer-${node.id}` };
    if (node.type === 'text') text(slide, node, font);
    else if (node.type === 'shape') slide.addShape(node.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { ...box, radius: inch(node.radius), rectRadius: inch(node.radius), fill: { color: node.fill.slice(1) }, line: { color: (node.stroke || node.fill).slice(1), transparency: node.stroke ? 0 : 100 } });
    else if (node.type === 'icon') slide.addImage({ ...box, data: dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">${designIconMarkup(node.icon, node.color)}</svg>`) });
    else if (node.type === 'image') {
      const image = assets.get(node.asset);
      slide.addImage({ ...box, data: image.data, w: inch(image.width), h: inch(image.height),
        sizing: { type: node.fit === 'contain' ? 'contain' : 'cover', w: box.w, h: box.h } });
    } else chart(pptx, slide, node, font);
  }
  return pptx.write({ outputType: 'blob' });
}
