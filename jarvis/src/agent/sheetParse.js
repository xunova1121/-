/**
 * 表格内容解析：CSV 或 Markdown 表格；用 “## 工作表名” 分成多个工作表。Excel、CSV 生成共用。
 * @param {string} content
 * @param {{ raw?: boolean }} [o]  raw：保留原文字（交给 xlsxWriter 识别千分位、百分数、金额、日期）；否则纯数字转成数字
 * @returns {Array<{ name: string, rows: Array<Array<string|number>> }>}
 */
export function parseSheets(content, { raw = false } = {}) {
  const sheets = [];
  let cur = null;
  for (const line of String(content).replace(/^﻿/, '').split('\n')) {
    const h = line.match(/^#{1,3}\s+(?:工作表[:：]?\s*)?(.*)$/);
    if (h) { cur = { name: h[1].trim().slice(0, 31) || `Sheet${sheets.length + 1}`, rows: [] }; sheets.push(cur); continue; }
    if (!line.trim()) continue;
    if (!cur) { cur = { name: 'Sheet1', rows: [] }; sheets.push(cur); }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim().replace(/^\*\*(.*)\*\*$/, '$1'));
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      cur.rows.push(cells);
    } else cur.rows.push(parseCsvLine(line.replace(/\r$/, '')));
  }
  // 数字字符串转为数字，Excel 里可以直接计算
  if (!raw) for (const s of sheets) s.rows = s.rows.map((r) => r.map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c)));
  return sheets;
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * 按“版块”解析（生成 Excel 用）：一个工作表里可以有标题说明、小节、多张表格、备注。
 *   ## 名称        新工作表（内容里没有 #/## 时，### 也当工作表，和以前一样）
 *   ### 小节       工作表里的小节标题
 *   | 表格 |       Markdown 表格；空行隔开的是两张表。不写“|---|”分隔行的是信息表（左列是名目，没有表头）
 *   普通文字       说明 / 备注（整行显示，自动换行）
 * 工作表里没有 Markdown 表格时，每行按 CSV 解析成一张表（和以前一样）。
 * @returns {Array<{ name: string, blocks: Array<{ kind: 'table', rows: string[][] } | { kind: 'section' | 'text', text: string }> }>}
 */
export function parseBlocks(content) {
  const text = String(content).replace(/^﻿/, '');
  const top = /^#{1,2}\s+\S/m.test(text);
  const sheetRe = top ? /^#{1,2}\s+(?:工作表[:：]?\s*)?(.*)$/ : /^#{1,3}\s+(?:工作表[:：]?\s*)?(.*)$/;
  const sheets = [];
  let cur = null;
  const open = (name) => { cur = { name: name.trim().slice(0, 31) || `Sheet${sheets.length + 1}`, lines: [] }; sheets.push(cur); };
  for (const line of text.split('\n')) {
    const h = line.match(sheetRe);
    if (h) { open(h[1]); continue; }
    if (!cur) { if (!line.trim()) continue; open('Sheet1'); }
    cur.lines.push(line.replace(/\r$/, ''));
  }
  const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
  const clean = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').trim();
  return sheets.map(({ name, lines }) => {
    const blocks = [];
    if (!lines.some(isTable)) {
      const rows = lines.filter((l) => l.trim()).map(parseCsvLine);
      if (rows.length) blocks.push({ kind: 'table', rows, header: true });
      return { name, blocks };
    }
    let table = null;
    for (const l of lines) {
      if (isTable(l)) {
        const cells = l.trim().slice(1, -1).split('|').map((c) => clean(c));
        if (cells.every((c) => /^:?-+:?$/.test(c))) { if (table) table.header = true; continue; }
        if (!table) { table = { kind: 'table', rows: [], header: false }; blocks.push(table); }
        table.rows.push(cells);
        continue;
      }
      table = null;
      if (!l.trim()) continue;
      const sec = l.match(/^#{3,6}\s+(.*)$/);
      if (sec) blocks.push({ kind: 'section', text: clean(sec[1]) });
      else blocks.push({ kind: 'text', text: clean(l.replace(/^\s*(?:>|[-*]\s)\s*/, '')) });
    }
    return { name, blocks };
  });
}
