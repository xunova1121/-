/** 新自由稿在安全空白内适配真实文字。固定坐标/画幅/原文不变，不搬动图片或覆盖其它元素。 */
import { normalizeLayerDesign, fitDesignText, designError } from './layeredDesignInput.js';
import { planLayerDesign } from './layeredDesignLayout.js';
import { designTextMinimum } from './layeredDesignPresentation.js';

const overlapsX = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + 0.01;
const contains = (a, b) => a.x <= b.x && a.x + a.w >= b.x + b.w && a.y <= b.y && a.y + a.h >= b.y + b.h;

function availableHeight(node, design) {
  let bottom = design.height;
  const index = design.layers.indexOf(node), gap = Math.min(8, design.width / 135);
  for (let i = 0; i < design.layers.length; i++) {
    const other = design.layers[i];
    if (other === node || !overlapsX(node, other)) continue;
    // 承载文字的原面板只提供自己的范围，不能跨过卡片下沿扩张到下一栏。
    if (i < index && other.type === 'shape' && contains(other, node)) {
      bottom = Math.min(bottom, Math.max(node.y + node.h, other.y + other.h - gap));
      continue;
    }
    if (other.y >= node.y + node.h - 0.01) bottom = Math.min(bottom, Math.max(node.y + node.h, other.y - gap));
    // 已在图上的文字可以留在自己的原框；未知人脸/主体保护区时绝不向图内扩大。
    else if (other.y + other.h > node.y + node.h && other.y < node.y + node.h) bottom = Math.min(bottom, node.y + node.h);
  }
  return Math.max(node.h, bottom - node.y);
}

export function prepareFreeLayerDesign(input, defaultSize) {
  const mode = input.design.text_fit ?? 'auto';
  if (!['auto', 'strict'].includes(mode)) throw designError('text_fit需为auto或strict');
  if (mode === 'strict') return { design: planLayerDesign(input, defaultSize), preflight: null };
  let draft;
  try { draft = planLayerDesign(input, defaultSize, { fitText: false }); }
  catch (error) {
    // 结构错误挡住自动适配时仍一次检查所有文字，避免修掉圆角才看见其它溢出。
    planLayerDesign(input, defaultSize);
    throw error;
  }
  const adjustments = [];
  for (const node of draft.layers) {
    if (node.type !== 'text' || !node.text.trim()) continue;
    const minimum = designTextMinimum(node, draft).fontSize;
    const candidate = { ...node, fontSize: Math.max(node.fontSize, minimum), minFontSize: Math.max(node.minFontSize, minimum) };
    try {
      const fitted = fitDesignText({ ...candidate, h: availableHeight(node, draft) });
      candidate.fontSize = fitted.fontSize;
      candidate.minFontSize = fitted.fontSize;
      candidate.h = Math.max(node.h, Math.ceil(fitted.rows.length * fitted.lineHeight * 1000) / 1000);
    } catch (error) {
      if (error.code !== 'DESIGN_TEXT_OVERFLOW') throw error;
      // 不冒险扩大或缩成小字；下面严格归一化统一报告所有仍放不下的框。
    }
    const changes = Object.fromEntries(['fontSize', 'minFontSize', 'h'].filter(key => candidate[key] !== node[key]).map(key => [key, { from: node[key], to: candidate[key] }]));
    if (Object.keys(changes).length) adjustments.push({ id: node.id, changes });
    Object.assign(node, candidate);
  }
  try {
    return { design: normalizeLayerDesign(draft), preflight: { status: 'passed', adjustments,
      basis: '仅在现有空白和卡片范围内适配文字；原文、坐标、画幅和素材未改，不代表视觉审美通过' } };
  } catch (error) {
    if (error.kind === 'input') error.adjustments = adjustments;
    throw error;
  }
}
