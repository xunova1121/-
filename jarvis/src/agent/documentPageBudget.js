import { documentError } from './documentPlan.js';

// 页数属于交付约束；不把页数范围或正文中引用的数字猜成总页数。
export function requestedSlides(text = '', limit = false) {
  const source = String(text);
  if (!/PPT|幻灯片|演示文稿/i.test(source)) return null;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const number = (s) => /^\d+$/.test(s) ? Number(s) : s.includes('十') ? (digits[s.split('十')[0]] || 1) * 10 + (digits[s.split('十')[1]] || 0) : digits[s];
  const matches = [...source.matchAll(/(?<![\d\-—~～至到第前后])([\d一二两三四五六七八九十]+)\s*页(?!\s*[-—~～至到])/g)];
  if (!matches.length) return null;
  const match = matches.at(-1);
  const bounded = /(?:最多|不超过|至多|上限(?:为)?|不多于)\s*$/.test(source.slice(Math.max(0, match.index - 12), match.index)) || /^\s*(?:以内|以下)/.test(source.slice(match.index + match[0].length));
  if (bounded !== limit) return null;
  let count = number(match[1]);
  if (/正文\s*$/.test(source.slice(Math.max(0, match.index - 8), match.index)) && /另加(?:一页)?封面/.test(source.slice(match.index + match[0].length, match.index + match[0].length + 16))) count += 1;
  return Number.isSafeInteger(count) && count > 0 && count <= 120 ? count : null;
}

/** 合并历史要求后的最后一次明确改口优先，不能让旧“不要封面”压过本轮“加封面”。 */
export function presentationCover(text = '') {
  const last = [...String(text).matchAll(/(?:不需要|不要|不用|无需|不加|不含|去掉|去除|包含|需要|含|加|带|要)[^\n，。；,;]{0,5}封面/g)].at(-1)?.[0] || '';
  const forbidCover = /^(?:不需要|不要|不用|无需|不加|不含|去掉|去除)/.test(last);
  return { forbidCover, requireCover: Boolean(last) && !forbidCover };
}

export function slideBudget(bodyCount, expectedSlides, requireCover = false, forbidCover = false, maxSlides = null) {
  if (maxSlides != null && expectedSlides != null && expectedSlides > maxSlides) throw documentError(`原PPT有${expectedSlides}页，超过本轮最多${maxSlides}页；请先调整内容，不能补图时偷偷删页`, 'DOCUMENT_SLIDE_COUNT');
  if (expectedSlides == null) {
    const cover = !forbidCover && (maxSlides == null || bodyCount < maxSlides || requireCover);
    if (maxSlides != null && bodyCount + Number(cover) > maxSlides) throw documentError(`最多${maxSlides}页，当前内容需要${bodyCount + Number(cover)}页；请调整版式，不自动删除内容`, 'DOCUMENT_SLIDE_COUNT');
    return { cover, strict: maxSlides != null };
  }
  if (!Number.isSafeInteger(expectedSlides) || expectedSlides < 1 || expectedSlides > 120) throw documentError('PPT总页数必须是1至120的整数', 'DOCUMENT_SLIDE_COUNT');
  if (bodyCount === expectedSlides && !requireCover) return { cover: false, strict: true };
  if (bodyCount + 1 === expectedSlides && !forbidCover) return { cover: true, strict: true };
  throw documentError(`要求总共${expectedSlides}页，当前有${bodyCount}页正文；请调整每页内容，封面也计入总页数，不自动删内容或补空页`, 'DOCUMENT_SLIDE_COUNT');
}
