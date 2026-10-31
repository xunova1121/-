import { requestedLength } from './documentLength.js';

/** 写作与交付共用显式字数范围。预留标题/表格标记余量，不靠末尾截断正文凑数。 */
export function documentWordBudget(task, words = 0) {
  const range = requestedLength(task);
  const numeric = Number(words);
  const target = range ? Math.round(range.min ? (range.min + range.max) / 2 : range.max * 0.85) : Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
  return { range, target, compact: Boolean(target && target <= 3000), note: range ? `篇幅硬约束：全文${range.min}至${range.max}字（含标题、表格、标点，不含空白）；起草目标${target}字。按全文预算安排各部分，不能把总字数当每节字数；不以截断结尾满足上限。` : target ? `全文目标约${target}字，给各节分配预算，不逐节扩成长文。` : '' };
}

export function budgetSections(sections, target, title = '') {
  if (!target || !sections.length) return sections;
  const available = Math.max(sections.length, target - Array.from(title.replace(/\s/g, '')).length);
  const weights = sections.map(s => Number.isFinite(Number(s.words)) && Number(s.words) > 0 ? Number(s.words) : 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  let allocated = 0;
  return sections.map((s, index) => {
    const words = index === sections.length - 1 ? available - allocated : Math.floor(available * weights[index] / sum);
    allocated += words;
    return { ...s, words };
  });
}
