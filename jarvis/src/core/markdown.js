/**
 * 极简 Markdown → 结构化块（不产出 HTML 字符串，DOM 侧用 textContent 组装，杜绝注入）。
 * 支持：段落、换行、- / * / 1. 列表、``` 代码块、**粗体**、`行内代码`。
 */
export function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', spans: inline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const li = line.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.*)$/);
    if (li) {
      flush();
      const last = blocks.at(-1);
      const ordered = /^\s*\d/.test(line);
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(inline(li[1]));
      else blocks.push({ type: 'list', ordered, items: [inline(li[1])] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

export function inline(text) {
  const spans = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[2] != null) spans.push({ text: m[2], bold: true });
    else spans.push({ text: m[3], code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}
