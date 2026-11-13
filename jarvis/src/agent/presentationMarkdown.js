// 将实际分页后的内容存成可再生成底稿；保留行内样式、表格、图片和备注，不从渲染截图反推正文。
const escaped = value => String(value ?? '').replace(/([\\`*_[\]<>|])/g, '\\$1');
function inline(runs = []) {
  return runs.map(run => {
    if (run.image) return `![${escaped(run.text)}](${run.image})`;
    let text = escaped(run.text);
    if (run.code) text = '`' + String(run.text).replace(/`/g, '\\`') + '`';
    if (run.bold) text = '**' + text + '**';
    if (run.italic) text = '*' + text + '*';
    if (run.strike) text = '~~' + text + '~~';
    if (run.link) text = '[' + text + '](' + run.link + ')';
    return text;
  }).join('');
}
function blocks(items) {
  return items.map(block => {
    if (block.type === 'heading') return '#'.repeat(Math.max(3, block.level)) + ' ' + inline(block.inlines);
    if (block.type === 'paragraph') return inline(block.inlines);
    if (block.type === 'image') return `![${escaped(block.alt)}](${block.src})`;
    if (block.type === 'table') {
      const row = cells => '| ' + cells.map(inline).join(' | ') + ' |';
      return [row(block.header), '| ' + block.header.map((_, i) => block.align?.[i] === 'right' ? '---:' : block.align?.[i] === 'center' ? ':---:' : '---').join(' | ') + ' |', ...block.rows.map(row)].join('\n');
    }
    if (block.type === 'list') return block.items.map((item, i) => (block.ordered ? (block.start || 1) + i + '. ' : '- ') + inline(item.inlines) + (item.children?.length ? '\n' + blocks(item.children).split('\n').map(line => '  ' + line).join('\n') : '')).join('\n');
    if (block.type === 'quote') return blocks(block.blocks).split('\n').map(line => '> ' + line).join('\n');
    if (block.type === 'code') return '````' + (block.lang || '') + '\n' + block.text + '\n````';
    return '';
  }).filter(Boolean).join('\n\n');
}
export function presentationMarkdown(slides, { title, cover, coverImages = [], agenda = [] }) {
  const pages = [];
  if (cover) pages.push('# ' + escaped(title) + '\n\n' + blocks(coverImages));
  if (agenda.length) pages.push('# 汇报提纲\n\n' + agenda.map(text => '- ' + escaped(text)).join('\n'));
  for (const slide of slides) pages.push([
    '# ' + escaped(slide.title),
    slide.wish ? '版式：' + slide.wish : '',
    slide.iconNames?.length ? '图标：' + slide.iconNames.join(', ') : '',
    blocks(slide.blocks),
    ...(slide.notes || []).map(note => '备注：' + note)
  ].filter(Boolean).join('\n\n'));
  return pages.join('\n\n---\n\n');
}
