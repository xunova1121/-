/** 内容一致、几何/真实像素可读性和视觉模型是独立证据，不承诺绝对无错字。 */
import { DOMParser } from '@xmldom/xmldom';
import { fitDesignText, normalizeLayerDesign } from './layeredDesignInput.js';
import { decodePngRgba, measureTextContrast, withoutText } from './posterContrast.js';
import { imageData } from './imageRegion.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { chartLabelNodes } from './layeredDesignSvg.js';

const textNodes = design => design.layers.flatMap(n => n.type === 'text' ? [n] : n.type === 'chart' ? chartLabelNodes(n) : []);

export function checkLayerCopy(design, svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const groups = new Map(Array.from(doc.getElementsByTagName('g')).map(n => [n.getAttribute('id'), n]));
  const expected = n => (n.type === 'text' ? [n] : chartLabelNodes(n)).map(t => fitDesignText(t).rows.join('')).join('');
  const failed = design.layers.filter(n => ['text', 'chart'].includes(n.type) && groups.get('layer-' + n.id)?.textContent !== expected(n)).map(n => n.id);
  return { status: failed.length ? 'failed' : 'passed', failed };
}
export function checkLayerOverlap(design) {
  const text = textNodes(design).filter(n => n.text.trim()), failed = [];
  for (let i = 0; i < text.length; i++) for (const b of text.slice(i + 1)) {
    const a = text[i], af = fitDesignText(a), bf = fitDesignText(b);
    const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const overlapH = Math.min(a.y + af.rows.length * af.lineHeight, b.y + bf.rows.length * bf.lineHeight) - Math.max(a.y, b.y);
    if (overlapW > 2 && overlapH > 2) failed.push([a.id, b.id]);
  }
  return { status: failed.length ? 'failed' : 'passed', failed: failed.slice(0, 8) };
}
export async function checkLayerContrast(design, svg, raster, signal) {
  const result = await raster(withoutText(svg), { signal });
  const image = await decodePngRgba(new Uint8Array(await result.blob.arrayBuffer()));
  if (!image || image.width !== design.width || image.height !== design.height) return { status: 'not_checked' };
  const blocks = textNodes(design).filter(n => n.text.trim()).flatMap(n => {
    const fitted = fitDesignText(n);
    return fitted.rows.filter(Boolean).map((row, i) => {
      const w = Math.min(n.w, [...row].length * fitted.fontSize), x = n.align === 'center' ? n.x + (n.w - w) / 2 : n.align === 'right' ? n.x + n.w - w : n.x;
      return { role: n.id, x, y: n.y + i * fitted.lineHeight, w, h: fitted.lineHeight, fontSize: fitted.fontSize, color: n.color };
    });
  });
  const measured = blocks.flatMap(block => measureTextContrast(image, [block], block.color).blocks);
  return { status: measured.every(b => b.ok) ? 'passed' : 'failed', failed: measured.filter(b => !b.ok).slice(0, 8).map(({ role, contrast, minimum }) => ({ id: role, contrast, minimum })) };
}
export function applyDesignState(design, state) {
  return normalizeLayerDesign({ ...design, states: [], layers: design.layers.map(node => ({ ...node, ...(state?.changes.find(c => c.id === node.id) || {}) })) });
}
/** 设计自审（与成品核验同一次看图，不多花一次调用）：只收布尔/null和简短改法 */
export const DESIGN_REVIEW_KEYS = ['hierarchy', 'cohesive', 'balanced', 'concept'];
function designReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = Object.fromEntries(DESIGN_REVIEW_KEYS.map(k => [k, typeof value[k] === 'boolean' ? value[k] : null]));
  out.suggestions = Array.isArray(value.suggestions) ? value.suggestions.filter(t => typeof t === 'string').slice(0, 4).map(t => t.slice(0, 160)) : [];
  return out;
}
/** 有配置才做一次实际成品看图；独立预算、无联网/重试/自动收费重画，失败保留候选文件。 */
export async function reviewLayeredDesign(ctx, design, png, { signal, retrieval, previewPng, previewKind, requiresRichVisual = false } = {}) {
  if (!ctx.visionLlm || !png || png.size > 12e6) return { status: 'not_checked', reason: '未配置视觉能力、未生成PNG或原图超过核验上限' };
  try {
    const images = [await imageData(png, { detail: 'high' })];
    if (previewPng && png.size + previewPng.size <= 12e6) images.push(await imageData(previewPng, { detail: 'high' }));
    throwControl(null, signal);
    retrieval?.consume?.('model');
    const result = await withWebDeadline(activeSignal => ctx.visionLlm({
      system: '你是成品核验员。先从实际图片读取文字，再与给定文案对照；不因为给了正确文案就推断图片里正确。检查错别字、缺字、乱码、文字清晰度、裁切/遮挡和不当重叠。中文看不清或小字不可辨认必须用null，不可猜。若第二张存在，它是整张海报缩至手机宽度的真实预览，必须以它判断正文能否正常阅读，不能以放大原图可读代替。检查主视觉是否挤压正文、是否残留空卡片/占位框、是否上图下文生硬拼接，发现则写issues；不能仅凭没有重叠就称设计通过。只返回JSON：copyMatches/readable/noOverlap各为true、false或null，issues为最多6条简短问题。事实真实性不在本次像素核验范围内。另以资深设计师标准返回design对象：hierarchy第一眼能否看出主次（标题/主图/重点），cohesive图文是否融为一体、没有硬拼接缝或孤立色块，balanced留白、对齐、疏密是否得当，concept是否实现给定构思（未给构思用null），各为true、false或null；suggestions最多4条具体改法（改哪个图层、往哪移、放大还是缩小、换什么图文关系），不建议删字或缩小正文。' + (previewKind === 'mobile_cards' ? '本次第二张不是整图缩放，而是交互Demo在手机上的卡片布局预览（按网页同样的分组和字号用同一字体排出，不是浏览器截图）；用它判断手机上是否好读、卡片顺序和配图是否合理，design各项要同时考虑电脑和手机两种宽度。' : '') + (requiresRichVisual ? '本任务要求图文并茂，另返回visualsPresent/relatedToTopic/integrated三个boolean或null：实际可见主题配图或有标签的数据图表、与主题有关、与文字有清楚关联且融合编排。数字卡片/装饰图标/空框不算配图；不相干图片或上图下文硬拼接不能通过；无法判断用null。' : ''),
      prompt: '请检查此实际成品' + (previewPng ? '和整图手机缩放预览' : '') + (design.concept ? '；设计构思：' + JSON.stringify(design.concept) : '') + '；应有的准确文案：\n' + textNodes(design).map(n => `${n.id}：${n.text}`).join('\n'),
      images, signal: activeSignal, allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0
    }), { signal, timeoutMs: 25000 });
    if (typeof result !== 'string' || result.length > 5000) return { status: 'not_checked', reason: '视觉回执无效' };
    const value = JSON.parse(result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const checks = Object.fromEntries(['copyMatches', 'readable', 'noOverlap', ...(requiresRichVisual ? ['visualsPresent', 'relatedToTopic', 'integrated'] : [])].map(k => [k, typeof value?.[k] === 'boolean' ? value[k] : null]));
    const validIssues = Array.isArray(value?.issues) && value.issues.every(s => typeof s === 'string');
    const issues = validIssues ? value.issues.slice(0, 6).map(s => s.slice(0, 160)) : null;
    const status = Object.values(checks).some(v => v === false) || issues?.length ? 'failed' : validIssues && Object.values(checks).every(v => v === true) ? 'passed' : 'not_checked';
    return { status, checks, issues: issues || [], ...(designReview(value?.design) && { design: designReview(value.design) }), basis: '一次实际PNG视觉核验；不证明文案事实绝对正确或所有像素毫无缺陷' };
  } catch (error) {
    throwControl(error, signal);
    return { status: 'not_checked', reason: '本次成品视觉核验未完成；候选与源稿已保留，未重试或重画' };
  }
}
