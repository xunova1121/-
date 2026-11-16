/** 分类对比不连成时间走势；零轴、标签及原值同源导出，不舍入业务数据。 */
import { wrapParagraphs } from './posterComposition.js';
export function barChartGeometry(node) {
  const step = node.h / node.points.length;
  const fontSize = Math.max(12, Math.min(44, step * 0.32, node.w * 0.04));
  const measured = node.points.map(p => {
    const value = String(p.value) + (node.unit || '');
    let width = node.w * 0.21;
    while (width < node.w && wrapParagraphs(value, fontSize, width)?.length !== 1) width += fontSize * 0.2;
    return width;
  });
  const valueWidth = Math.max(...measured);
  const left = node.x + node.w * 0.41, width = node.w * 0.57 - valueWidth;
  if (width < node.w * 0.12) throw Object.assign(new Error('图表原值过长，请加宽图表；未舍入或截断数据'), { code: 'DESIGN_CHART_LABEL', kind: 'validation' });
  const low = Math.min(0, ...node.points.map(p => p.value)), high = Math.max(0, ...node.points.map(p => p.value));
  const span = high - low || 1, zero = left + (0 - low) / span * width;
  const bars = node.points.map((p, i) => {
    const endpoint = left + (p.value - low) / span * width, y = node.y + step * i + step * 0.33;
    return { x: Math.min(zero, endpoint), y, w: Math.abs(endpoint - zero), h: step * 0.34, value: p.value };
  });
  const labels = node.points.flatMap((p, i) => [
    { text: p.label, x: node.x, w: node.w * 0.38 },
    { text: String(p.value) + (node.unit || ''), x: node.x + node.w - valueWidth, w: valueWidth }
  ].map((label, j) => ({ ...label, id: `${node.id}-bar-${i}-${j}`, type: 'text', y: node.y + step * i + (step - fontSize * 1.4) / 2,
    h: fontSize * 1.4, fontSize, minFontSize: fontSize, color: node.color, weight: 400, align: j ? 'right' : 'left', role: 'body' })));
  return { zero, bars, labels };
}
