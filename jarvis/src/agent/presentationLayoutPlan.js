import { plain } from './docModel.js';
const continuationTitle = title => String(title).replace(/[（(](?:续|\d+(?:\s*[/／]\s*\d+)?)[）)]\s*$/, '').replace(/(?:第\s*\d+\s*[/／]\s*\d+\s*页|[（(]续[）)])\s*$/, '').trim();
/** 只合并明确续表且表头相同，绝不把不同业务页或用户指定页数偷偷删掉。 */
export function planTablePages(slides, { strict = false } = {}) {
  const grouped = [];
  for (const slide of slides) {
    const table = slide.blocks.length === 1 && slide.blocks[0].type === 'table' ? slide.blocks[0] : null;
    const previous = grouped.at(-1), prevTable = previous?.blocks.length === 1 ? previous.blocks[0] : null;
    if (!strict && table && prevTable?.type === 'table' && continuationTitle(slide.title) === continuationTitle(previous.title)
      && slide.title !== previous.title && JSON.stringify(table.header) === JSON.stringify(prevTable.header)) {
      previous.blocks = [{ ...prevTable, rows: [...prevTable.rows, ...table.rows] }];
      previous.notes = [...previous.notes, ...slide.notes];
    } else grouped.push({ ...slide });
  }
  return grouped.flatMap(slide => {
    const table = slide.blocks.find(block => block.type === 'table');
    if (!table) return [slide];
    // 长单元格仍减少行数，不用压小字号换取强行塞满。
    const longest = Math.max(0, ...table.rows.flat().map(cell => plain(cell).length));
    const capacity = longest > 32 || table.header.length > 6 ? 6 : 12;
    if (table.rows.length <= capacity) return [slide];
    const count = Math.ceil(table.rows.length / capacity);
    return Array.from({ length: count }, (_, index) => ({ ...slide,
      title: `${continuationTitle(slide.title)} 第${index + 1}/${count}页`,
      blocks: slide.blocks.map(block => block === table ? { ...table, rows: table.rows.slice(index * capacity, (index + 1) * capacity) } : block),
      notes: index ? [] : slide.notes
    }));
  });
}
/** 仅清理中文标点周围空格，时间转换为常规半角冒号，不触碰URL/代码。 */
export function tidyPresentationPunctuation(text) {
  return String(text).replace(/(\d)\s*：\s*(?=\d)/g, '$1:').replace(/[ \t]*：[ \t]*/g, '：').replace(/[ \t]*（[ \t]*/g, '（').replace(/[ \t]*）/g, '）');
}
