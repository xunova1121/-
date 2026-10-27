// Word分页只从真实PDF读取；不以字数、标题数或DOCX缓存页数代替。
export function requestedWordPages(requirements = '') {
  const instruction = String(requirements).slice(0, 120000).split(/^#\s/m)[0];
  let latest = null;
  for (const clause of instruction.split(/[。；;\n]/)) {
    if (!/Word|docx/i.test(clause) || /PPT|幻灯片|Excel/i.test(clause)) continue;
    if (/正文[^。；;]*页|另加[^。；;]*封面|不含[^。；;]*封面/.test(clause)) continue;
    const matches = clause.matchAll(
      /(?<![\d第前后至到~～—-])([1-9]\d{0,2}|[一二两三四五六七八九十]{1,3})\s*(?:[-—~～至到]\s*([1-9]\d{0,2}|[一二两三四五六七八九十]{1,3})\s*)?页/g
    );
    for (const match of matches) {
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + match[0].length);
      if (/(?:大约|约|大概)\s*$/.test(before) || /^\s*(?:左右|上下|附近)/.test(after)) continue;
      const first = pageNumber(match[1]);
      const second = match[2] ? pageNumber(match[2]) : null;
      if (!first || (match[2] && !second)) continue;
      const maximum = /(?:不超过|不得超过|最多|上限(?:为)?|至多|控制在)\s*$/.test(before) || /^\s*(?:以内|之内)/.test(after);
      const minimum = /(?:不少于|至少|不低于)\s*$/.test(before);
      const min = second ? first : maximum ? 1 : first;
      const max = second || (minimum ? null : first);
      if (max !== null && min > max) continue;
      latest = { min, max };
    }
  }
  return latest;
}

function pageNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (digits[value]) return digits[value];
  if (!/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) return null;
  const [tens, units] = value.split('十');
  return (digits[tens] || 1) * 10 + (digits[units] || 0);
}

export function checkWordPages(budget, pages) {
  if (!budget) return null;
  const measured = Number.isSafeInteger(pages) && pages > 0;
  return {
    ...budget,
    actual: measured ? pages : null,
    state: !measured ? 'not_checked' : pages >= budget.min && (budget.max === null || pages <= budget.max) ? 'passed' : 'failed',
    scope: '整份Word真实转换PDF的总页数，含原有封面和目录'
  };
}
