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

// 行内：**粗体**、`代码`、[文字](网址)、裸网址。网址外面包着的括号“([来源](…))”一起去掉，显示成来源标签
const STOP = `\\s<>()（）[\\]，。；、"'“”`;
const INLINE = new RegExp(
  '\\*\\*(?<bold>[^*]+)\\*\\*|`(?<code>[^`]+)`' +
  '|(?<open>[(（])?\\[(?<label>[^\\]\\n]+)\\]\\((?<href>https?:\\/\\/[^\\s)]+)\\)(?<close>[)）])?' +
  `|(?<bare>https?:\\/\\/[^${STOP}]*[^${STOP}.,;:!?])`, 'g');

export function inline(text) {
  const spans = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups;
    let start = m.index;
    let end = m.index + m[0].length;
    // 括号只有左右都在时才一起去掉，否则还给正文
    if (g.label != null && Boolean(g.open) !== Boolean(g.close)) { if (g.open) start++; else end--; }
    if (start > last) spans.push({ text: text.slice(last, start) });
    if (g.bold != null) spans.push({ text: g.bold, bold: true });
    else if (g.code != null) spans.push({ text: g.code, code: true });
    else if (g.label != null) spans.push({ text: g.label.trim(), link: cleanUrl(g.href) });
    else spans.push({ text: g.bare, link: cleanUrl(g.bare) });
    last = end;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

/** 去掉搜索带出来的跟踪参数（utm_source=openai 之类） */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.href.replace(/\?$/, '');
  } catch { return url; }
}
