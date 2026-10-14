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
