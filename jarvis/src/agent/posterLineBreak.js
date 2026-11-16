/** 数字单位成组，中文标点不独占行首；全文逐字保留，放不下由上层调整版式。 */
export function wrapPosterLine(paragraph, fontSize, width, graphemes, glyphUnits) {
  const pieces = paragraph.split(/(\d{2,4}年\d{1,2}月\d{1,2}日|[+−-]?\d+(?:[./:：\-–]\d+)*(?:\s?(?:m\/s|km\/h|token\/s|mm|cm|km|kg|MB|GB|px|%|℃|°C|万元|亿元|万亿|亿|万|元|岁|年|月|日|时|分|秒|点))?)/g);
  const measure = text => graphemes(text).reduce((sum, glyph) => sum + glyphUnits(glyph) * fontSize, 0);
  const tokens = pieces.flatMap((piece, i) => {
    if (!i || i % 2 === 0 || piece.length > 32) return graphemes(piece);
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
        carry = /^\d/.test(previousToken) && row.endsWith(previousToken) ? previousToken : letters.pop();
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
