/**
 * 表格 → Excel（.xlsx），用 ExcelJS（MIT）。读取仍用 SheetJS（docs.js），互不影响。
 *
 *   样式    表头加粗、主题色底白字、细边框、隔行浅底；冻结首行、加筛选；列宽按内容
 *   格式    “1,200”→ 数字 #,##0；“18%”→ 0.18 显示 0.0%；“2026-10-14”→ 日期；“¥1,200 / 1200元”→ 金额
 *   公式    单元格写“=SUM(B2:B5)”就是公式；另外自动补：
 *             合计 / 总计 / 小计 行：数字列 = SUM(上面各行)
 *             增长率 / 同比 / 环比 / 增幅 列：=(本期-上期)/上期（按表头认出本期和上期）
 *             完成率 / 达成率 列：=实际/目标
 *           公式同时写入算好的结果，不重新计算的软件（和贾维斯自己读回时）也能看到数值
 */
import { parseSheets } from './sheetParse.js';

const CJK = /[⺀-￿]/;
const width = (v) => [...String(v ?? '')].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** 文字 → { value, numFmt }：识别千分位数字、百分数、金额、日期 */
export function typed(raw) {
  if (typeof raw === 'number') return { value: raw, numFmt: Number.isInteger(raw) ? '#,##0' : '#,##0.00' };
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  if (s.startsWith('=') && s.length > 1) return { formula: s.slice(1) };
  let m = s.match(/^([-+]?\d+(?:\.\d+)?)\s*%$/);
  if (m) return { value: Number(m[1]) / 100, numFmt: m[1].includes('.') ? '0.0%' : '0%' };
  m = s.match(/^[¥￥$]\s*([-+]?[\d,]+(?:\.\d+)?)$|^([-+]?[\d,]+(?:\.\d+)?)\s*元$/);
  if (m) { const n = Number((m[1] ?? m[2]).replace(/,/g, '')); if (Number.isFinite(n)) return { value: n, numFmt: s.startsWith('$') ? '"$"#,##0.00' : '"¥"#,##0.00' }; }
  m = s.match(/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/) ?? s.match(/^[-+]?\d+(\.\d+)?$/);
  if (m && !/^0\d/.test(s.replace(/^[-+]/, ''))) { const n = Number(s.replace(/,/g, '')); return { value: n, numFmt: s.includes('.') ? '#,##0.00' : '#,##0' }; }
  m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) return { value: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), numFmt: 'yyyy-mm-dd' };
  return { value: s };
}

const TOTAL = /^(合计|总计|小计|总和|共计|total)$/i;
const GROWTH = /增长率|增幅|同比|环比|增速|变化率/;
const DONE = /完成率|达成率|完成比例/;
const CUR = /本期|本年|今年|本月|当期|实际|完成|本季/;
const PREV = /上期|上年|去年|上月|同期|基期|上季/;
const PLAN = /目标|计划|预算|任务/;

/** 认出“本期”“上期”列：表头关键词优先，其次两个年份里大的是本期 */
function pickPair(headers, numericCols, re1, re2) {
  const a = numericCols.find((i) => re1.test(headers[i]));
  const b = numericCols.find((i) => re2.test(headers[i]) && i !== a);
  if (a != null && b != null) return [a, b];
  const years = numericCols.map((i) => [i, Number(String(headers[i]).match(/(20\d{2}|19\d{2})/)?.[1])]).filter(([, y]) => y);
  if (re1 === CUR && years.length >= 2) {
    years.sort((x, y) => y[1] - x[1]);
    return [years[0][0], years[1][0]];
  }
  return null;
}

/**
 * @param {string} content  CSV / Markdown 表格，“## 名称”分工作表
 * @param {{ theme: object }} o
 * @returns {Promise<{ blob: Blob, info: { sheets: number, formulas: number } }>}
 */
export async function makeXlsx(content, { theme }) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = '贾维斯';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true; // Excel / WPS 打开时重新计算全部公式
  const C = theme.colors;
  const official = Boolean(theme.official);
  const headFill = official ? 'FFD9D9D9' : `FF${C.accent}`;
  const headFont = official ? 'FF000000' : 'FFFFFFFF';
  const zebra = `FF${official ? 'FFFFFF' : C.soft}`;
  const border = { style: 'thin', color: { argb: 'FFBFC7D1' } };
  const borders = { top: border, left: border, bottom: border, right: border };
  let formulas = 0;

  const sheets = parseSheets(content, { raw: true });
  if (!sheets.length) sheets.push({ name: 'Sheet1', rows: [] });
  const used = new Set();
  for (const s of sheets) {
    let name = s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    for (let k = 2; used.has(name); k++) name = `${s.name.slice(0, 28)}(${k})`;
    used.add(name);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: s.rows.length > 1 ? 1 : 0 }] });
    const rows = s.rows;
    if (!rows.length) continue;
    const headers = rows[0].map(String);
    const cols = Math.max(...rows.map((r) => r.length));
    // 先把所有单元格转成带类型的值
    const grid = rows.map((r, ri) => Array.from({ length: cols }, (_, ci) => (ri === 0 ? { value: r[ci] ?? '' } : typed(r[ci]))));
    const bodyRows = grid.slice(1).map((row, k) => ({ row, r: k + 2 }));
    const isTotal = (row) => TOTAL.test(String(row[0]?.value ?? '').trim());
    const dataRows = bodyRows.filter(({ row }) => !isTotal(row));
    const numericCols = [...Array(cols).keys()].filter((ci) => dataRows.some(({ row }) => typeof row[ci]?.value === 'number'));

    const growthCols = new Set([...Array(cols).keys()].filter((ci) => GROWTH.test(headers[ci] ?? '') || DONE.test(headers[ci] ?? '')));
    // 合计行：数字列 = SUM(上面的数据行)（先算合计，后面的增长率才能用上合计的数）
    for (const { row, r } of bodyRows) {
      if (!isTotal(row)) continue;
      const above = dataRows.filter((d) => d.r < r);
      if (!above.length) continue;
      for (const ci of numericCols) {
        if (ci === 0 || growthCols.has(ci) || row[ci]?.formula) continue;
        const from = above[0].r; const to = above.at(-1).r;
        const sum = above.reduce((n, d) => n + (typeof d.row[ci]?.value === 'number' ? d.row[ci].value : 0), 0);
        const fmt = above.find((d) => d.row[ci]?.numFmt)?.row[ci].numFmt ?? '#,##0';
        if (fmt.includes('%')) continue; // 百分比列加总没有意义
        row[ci] = { formula: `SUM(${colName(ci)}${from}:${colName(ci)}${to})`, result: Math.round(sum * 1e6) / 1e6, numFmt: fmt };
      }
    }
    // 增长率 / 完成率列：自动公式
    const numOf = (c) => (typeof c?.value === 'number' ? c.value : typeof c?.result === 'number' ? c.result : null);
    for (const ci of growthCols) {
      const h = headers[ci];
      const others = numericCols.filter((i) => i !== ci && !growthCols.has(i));
      const growth = GROWTH.test(h);
      const pair = growth ? pickPair(headers, others, CUR, PREV) : pickPair(headers, others, CUR, PLAN);
      if (!pair) continue;
      const [a, b] = pair;
      for (const { row, r } of bodyRows) {
        if (row[ci]?.formula) continue;
        const va = numOf(row[a]); const vb = numOf(row[b]);
        const A = `${colName(a)}${r}`; const B = `${colName(b)}${r}`;
        const result = va !== null && vb !== null && vb !== 0 ? (growth ? (va - vb) / vb : va / vb) : '';
        row[ci] = { formula: growth ? `IFERROR((${A}-${B})/${B},"")` : `IFERROR(${A}/${B},"")`, result, numFmt: '0.0%' };
      }
    }

    // 写入
    grid.forEach((row, ri) => {
      const xr = ws.getRow(ri + 1);
      row.forEach((c, ci) => {
        const cell = xr.getCell(ci + 1);
        if (c.formula) { cell.value = { formula: c.formula, ...(c.result !== undefined && { result: c.result }) }; formulas++; } else cell.value = c.value ?? null;
        if (c.numFmt) cell.numFmt = c.numFmt;
        cell.border = borders;
        cell.font = { name: '微软雅黑', size: 10.5 };
        cell.alignment = { vertical: 'middle', wrapText: true, horizontal: typeof c.value === 'number' || c.formula ? 'right' : undefined };
        if (ri === 0) {
          cell.font = { name: '微软雅黑', size: 10.5, bold: true, color: { argb: headFont } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headFill } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        } else if (TOTAL.test(String(row[0]?.value ?? '').trim())) {
          cell.font = { name: '微软雅黑', size: 10.5, bold: true };
        } else if (ri % 2 === 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
        }
      });
      xr.height = ri === 0 ? 24 : 20;
    });
    // 列宽、筛选
    for (let ci = 0; ci < cols; ci++) {
      const w = Math.max(...rows.map((r) => width(r[ci])), 4);
      ws.getColumn(ci + 1).width = Math.min(50, Math.max(8, w + 3));
    }
    if (rows.length > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols } };
  }
  const buf = await wb.xlsx.writeBuffer();
  return { blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), info: { sheets: sheets.length, formulas } };
}

/** CSV：带 UTF-8 BOM，Excel 双击打开中文不乱码 */
export function makeCsv(content) {
  const sheets = parseSheets(content, { raw: true });
  const rows = sheets[0]?.rows ?? [];
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = rows.map((r) => r.map(q).join(',')).join('\r\n');
  return new Blob([`﻿${text}\r\n`], { type: 'text/csv;charset=utf-8' });
}

export const withBom = (s) => (String(s).startsWith('﻿') ? String(s) : `﻿${s}`);
