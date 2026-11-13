/** 使用与绘制一致的宽度估算；容量不足明确报错，不裁字冒充完整。 */
export function diagramLines(text, units, limit) {
  const result = [];
  let line = '';
  let size = 0;
  for (const letter of [...text]) {
    const step = /[\u0000-\u007f]/.test(letter) ? 0.58 : 1;
    if (letter === '\n' || size + step > units) {
      result.push(line);
      line = '';
      size = 0;
    }
    if (letter !== '\n') {
      line += letter;
      size += step;
    }
  }
  if (line) result.push(line);
  // 避免中文说明末行只剩一两个字；只调整换行，不删改文字。
  if (result.length > 1 && /^[\u4e00-\u9fff，。；、]{1,2}$/.test(result.at(-1)) && [...result.at(-2)].length >= 5 && units >= 4) {
    const previous = [...result.at(-2)];
    result[result.length - 1] = previous.splice(-2).join('') + result.at(-1);
    result[result.length - 2] = previous.join('');
  }
  if (result.length > limit)
    throw Object.assign(new Error('节点文字超过当前版面容量，请精简或拆分节点，未生成截断文字的图'), { code: 'DIAGRAM_TEXT_OVERFLOW', kind: 'input' });
  return result;
}

export const escapeSvg = (value) =>
  String(value).replace(/[&<>"']/g, (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[letter]);

export function diagramText(text, x, y, width, size, maxLines, color, weight = 400) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${diagramLines(text, width / size, maxLines)
    .map((line, index) => `<tspan x="${x}" dy="${index ? size * 1.4 : 0}">${escapeSvg(line)}</tspan>`)
    .join('')}</text>`;
}
