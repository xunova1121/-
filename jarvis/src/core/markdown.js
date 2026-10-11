/**
 * 极简 Markdown → 结构化块（不产出 HTML 字符串，DOM 侧用 textContent 组装，杜绝注入）。
 * 支持：# 标题（1–3 级）、段落、换行、- / * / 1. 列表、``` 代码块、| 表格 |、**粗体**、`行内代码`。
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
      const lang = line.slice(3).trim().split(/\s/)[0] || '';
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n'), lang });
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ type: 'heading', level: h[1].length, spans: inline(h[2].trim()) });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // 分隔行
        rows.push(cells);
      }
      i--;
      blocks.push({ type: 'table', rows });
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
