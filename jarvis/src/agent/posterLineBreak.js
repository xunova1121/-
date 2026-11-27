/** 数字单位成组，中文标点不独占行首；全文逐字保留，放不下由上层调整版式。 */
export function wrapPosterLine(paragraph, fontSize, width, graphemes, glyphUnits, wordWrap = false) {
  const pieces = paragraph.split(/(\d{2,4}年\d{1,2}月\d{1,2}日|[+−-]?\d+(?:[./:：\-–]\d+)*(?:\s?(?:m\/s|km\/h|token\/s|mm|cm|km|kg|MB|GB|px|%|℃|°C|万元|亿元|万亿|亿|万|元|岁|年|月|日|时|分|秒|点))?)/g);
  const measure = text => graphemes(text).reduce((sum, glyph) => sum + glyphUnits(glyph) * fontSize, 0);
  const words = text => {
    const segments = typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)].map(s => s.segment)
      : text.match(/[A-Za-z]+|[^A-Za-z]/gu) || [];
    // 标识符在下划线处可换行，普通单词和中文词组只在确实比整行宽时才拆字。
    return segments.flatMap(s => s.split(/([_/])/)).filter(Boolean).flatMap(s => measure(s) <= width ? [s] : graphemes(s));
  };
  const tokens = pieces.flatMap((piece, i) => {
    if (!i || i % 2 === 0 || piece.length > 32) return wordWrap ? words(piece) : graphemes(piece);
    if (/^\d+年\d+月\d+日$/.test(piece) && measure(piece) > width) return piece.match(/\d+[年月日]/g);
    return [piece];
  });
  const rows = [];
  let row = '', used = 0, previousToken = '';
  for (const token of tokens) {
    const advance = measure(token);
    if (advance > width) return null;
    if (row && used + advance > width) {
      const letters = graphemes(row), tail = letters.at(-1);
      let carry = '';
      if (/^[，。！？；：、,.!?;:）】》」』]/.test(token) || /[（【《「『]$/.test(tail)) {
        const keepToken = wordWrap ? previousToken && measure(previousToken + token) <= width : /^\d/.test(previousToken);
        carry = keepToken && row.endsWith(previousToken) ? previousToken : letters.pop();
        row = row.slice(0, -carry.length);
        if (!row || measure(carry + token) > width) return null;
      }
      rows.push(row);
      row = carry;
      used = measure(carry);
    }
    row += token;
    used += advance;
    previousToken = token;
  }
  rows.push(row);
  // 尾行只剩一两个字（或一个短词）时，从上一行按原词边界匀一点空间，不删字或拆数值。
  if (wordWrap && rows.length > 1 && measure(rows.at(-1)) < width * 0.28) {
    const combined = rows.at(-2) + rows.at(-1), start = paragraph.length - combined.length;
    let offset = 0, best;
    for (const token of tokens) {
      offset += token.length;
      const split = offset - start;
      if (split <= 0 || split >= combined.length) continue;
      const head = combined.slice(0, split), tail = combined.slice(split);
      if (measure(head) >= width * 0.45 && measure(head) <= width && measure(tail) >= width * 0.3 && measure(tail) <= width
        && !/[（【《「『]$/.test(head) && !/^[，。！？；：、,.!?;:）】》」』]/.test(tail)) best = [head, tail];
    }
    if (best) rows.splice(-2, 2, ...best);
  }
  if (rows.length > 1 && /^\p{Script=Han}$/u.test(rows.at(-1))) {
    const previous = rows.at(-2), combined = previous + rows.at(-1);
    const words = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(combined)] : [];
    const word = words.find(w => w.index < previous.length && w.index + w.segment.length > previous.length);
    const point = word?.index ?? Math.max(1, previous.length - 1);
    const tail = combined.slice(point), head = combined.slice(0, point);
    if (head && measure(tail) <= width && !/[（【《「『]$/.test(head)) rows.splice(-2, 2, head, tail);
  }
  return rows;
}
