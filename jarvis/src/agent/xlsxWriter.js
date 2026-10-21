/**
 * 表格 → Excel（.xlsx），用 ExcelJS（MIT）。读取仍用 SheetJS（docs.js），互不影响。
 *
 *   样式    表头加粗、主题色底白字、细边框、隔行浅底；冻结首行、加筛选；列宽按内容
 *   格式    “1,200”→ 数字 #,##0；“18%”→ 0.18 显示 0.0%；“2026-10-14”→ 日期；“¥1,200 / 1200元”→ 金额
 *   公式    单元格写“=SUM(B2:B5)”就是公式；另外自动补：
 *             合计 / 总计 / 小计 行：数字列 = SUM(上面各行)
 *             增长率 / 同比 / 环比 / 增幅 列：=(本期-上期)/上期（按表头认出本期和上期）
 *             完成率 / 达成率 列：=实际/目标
 *           公式同时写入算好的结果，不重新计算的软件（和未央自己读回时）也能看到数值
 */
import { parseSheets, parseBlocks } from './sheetParse.js';
import { checkFormulas, sheetLayout, colName } from './formulaCheck.js';
import { evaluateWorkbook } from './formulaEval.js';

const CJK = /[⺀-￿]/;
const width = (v) => [...String(v ?? '')].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);

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

const SHARE = /占比|比重|构成比|所占比例|占总/;
/** 表头像比率：设百分比格式；带金额 / 数量单位的（“同比增减（万元）”）不算 */
const PCT_HEAD = /率|占比|比重|比例|同比|环比|增幅|增速/;
const AMOUNT_HEAD = /万元|元|金额|数量|人数|增减|个数|（[^）]*[元个人台套吨]）|\([^)]*[元个人台套吨]\)/;
/** 没写分隔行、但第一行全是“项目 / 数值 / 指标 / 说明”这类表头词：当作带表头的表 */
const HEAD_WORD = /^(项目|指标|名称|内容|数值|数据|说明|类别|区域|序号|编号|备注|单位|时间|日期|金额|数量|完成情况|目标|实际|负责人|事项)$/;
const looksLikeHeader = (rows) => rows.length > 2 && rows[0].length >= 2 && rows[0].every((c) => HEAD_WORD.test(String(c ?? '').trim()));
const MONEY = /金额|投资|费用|预算|万元|元|成本|收入|销售额/;
const isTotalRow = (row) => [0, 1].some((ci) => TOTAL.test(String(row[ci]?.value ?? '').trim()));

/**
 * 一张表：文字 → 带类型的单元格，补上合计、增长率 / 完成率、占比公式
 * @param {string[][]} rows 第一行是表头
 * @param {number} r0 表头在 Excel 里的行号（公式要用真实行号）
 */
function buildTable(rows, r0, header = true) {
  const headers = header ? rows[0].map((h) => String(h ?? '')) : [];
  const cols = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r, ri) => Array.from({ length: cols }, (_, ci) => (header && ri === 0 ? { value: r[ci] ?? '' } : typed(r[ci]))));
  const bodyRows = grid.slice(header ? 1 : 0).map((row, k) => ({ row, r: r0 + (header ? 1 : 0) + k }));
  const dataRows = bodyRows.filter(({ row }) => !isTotalRow(row));
  const numericCols = [...Array(cols).keys()].filter((ci) => dataRows.some(({ row }) => typeof row[ci]?.value === 'number'));
  const shareCols = new Set([...Array(cols).keys()].filter((ci) => SHARE.test(headers[ci] ?? '')));
  const growthCols = new Set([...Array(cols).keys()].filter((ci) => !shareCols.has(ci) && (GROWTH.test(headers[ci] ?? '') || DONE.test(headers[ci] ?? ''))));
  let formulas = 0;
  // 合计行：数字列 = SUM(上面的数据行)（先算合计，后面的增长率、占比才能用上合计的数）
  for (const { row, r } of bodyRows) {
    if (!isTotalRow(row)) continue;
    const above = dataRows.filter((d) => d.r < r);
    if (!above.length) continue;
    for (const ci of numericCols) {
      if (ci === 0 || growthCols.has(ci) || shareCols.has(ci) || row[ci]?.formula) continue;
      const from = above[0].r; const to = above.at(-1).r;
      const sum = above.reduce((n, d) => n + (typeof d.row[ci]?.value === 'number' ? d.row[ci].value : 0), 0);
      const fmt = above.find((d) => d.row[ci]?.numFmt)?.row[ci].numFmt ?? '#,##0';
      if (fmt.includes('%')) continue; // 百分比列加总没有意义
      row[ci] = { formula: `SUM(${colName(ci)}${from}:${colName(ci)}${to})`, result: Math.round(sum * 1e6) / 1e6, numFmt: fmt };
    }
  }
  const numOf = (c) => (typeof c?.value === 'number' ? c.value : typeof c?.result === 'number' ? c.result : null);
  // 增长率 / 完成率列：自动公式
  for (const ci of growthCols) {
    const h = headers[ci];
    const others = numericCols.filter((i) => i !== ci && !growthCols.has(i) && !shareCols.has(i));
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
  // 占比 / 比重列：= 本行 ÷ 合计（没有合计行时 ÷ 各行之和）；按左边最近的金额列算，没有金额列就用最近的数字列
  for (const ci of shareCols) {
    const cands = numericCols.filter((i) => i !== ci && !shareCols.has(i) && !growthCols.has(i) && !String(numOf(dataRows[0]?.row[i]) ?? '').includes('%') && !(dataRows[0]?.row[i]?.numFmt ?? '').includes('%'));
    const left = cands.filter((i) => i < ci);
    const base = [...left].reverse().find((i) => MONEY.test(headers[i])) ?? left.at(-1) ?? cands.find((i) => MONEY.test(headers[i])) ?? cands[0];
    if (base == null || !dataRows.length) continue;
    const L = colName(base);
    const totalRow = bodyRows.find(({ row }) => isTotalRow(row) && numOf(row[base]) !== null);
    const denom = totalRow ? `${L}$${totalRow.r}` : `SUM(${L}$${dataRows[0].r}:${L}$${dataRows.at(-1).r})`;
    const total = totalRow ? numOf(totalRow.row[base]) : dataRows.reduce((n, d) => n + (numOf(d.row[base]) ?? 0), 0);
    for (const { row, r } of bodyRows) {
      const v = numOf(row[base]);
      if (v === null || row[ci]?.formula) continue; // 已经写了公式（模型自己写的）就照用，不覆盖
      row[ci] = { formula: `IFERROR(${L}${r}/${denom},"")`, result: total ? v / total : '', numFmt: '0.0%' };
    }
  }
  // 比率类的列（同比、增长率、占比、完成率……）：模型自己写的公式也设成百分比格式，不显示成 0.2058… 这样的长小数
  const pctCols = [...Array(cols).keys()].filter((ci) => PCT_HEAD.test(headers[ci] ?? '') && !AMOUNT_HEAD.test(headers[ci] ?? ''));
  for (const ci of pctCols) for (const { row } of bodyRows) if (row[ci]?.formula && !row[ci].numFmt) row[ci].numFmt = '0.0%';
  // 信息表（左边名目、右边值）：名目是“增长率”“占比”之类的，右边的公式也设成百分比
  const pctLabel = (v) => PCT_HEAD.test(String(v ?? '')) && !AMOUNT_HEAD.test(String(v ?? ''));
  if (!header) for (const row of grid) row.forEach((c, ci) => { if (ci > 0 && c.formula && !c.numFmt && pctLabel(row[ci - 1]?.value)) c.numFmt = '0.0%'; });
  // 带表头的“项目 | 数值”表：这一行的名目是比率，这一行的公式也设成百分比
  else for (const { row } of bodyRows) if (pctLabel(row[0]?.value)) row.forEach((c, ci) => { if (ci > 0 && c.formula && !c.numFmt) c.numFmt = '0.0%'; });
  for (const row of grid) for (const c of row) if (c.formula) formulas++;
  return { grid, cols, formulas };
}

/** 估算一格文字要几行（Excel 不会替我们按换行算行高） */
const linesFor = (text, colWidth) => String(text ?? '').split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(width(part) / Math.max(4, colWidth - 1.5))), 0);

const SEQ_HEAD = /^(序号|编号|No\.?|#)$/i;
const cellKey = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/**
 * 找出重复的数据行（重新生成或局部改表时，模型常把边界那一行写两遍，如最后两行都是“18:00-19:30 晚餐”）：
 *   - 除序号列外每格都一样
 *   - 一行填了的格子另一行都有、且内容一样（如同一时间段，一行备注空着）：算填得少的那行多余
 * 只比较整行，不按单独某一列（时间、日期）判断：同一天多笔流水、同一时段两项活动都是正常数据。
 * 空行、只填了一格的行（小计、说明）不参与比较。
 * @returns {Array<{ keep: number, drop: number }>} 行下标（从 0 数）
 */
export function duplicateRows(rows, header = true) {
  const start = header ? 1 : 0;
  const seq = header ? (rows[0] ?? []).map((h) => SEQ_HEAD.test(cellKey(h))) : [];
  const keys = rows.map((r, ri) => (ri < start ? null : (r ?? []).map((c, ci) => (seq[ci] ? '' : cellKey(c)))));
  const filled = (k) => k.filter(Boolean).length;
  // a 填了的格子 b 都有且一样
  const covers = (b, a) => a.every((v, ci) => !v || v === b[ci]);
  const pairs = [];
  const dropped = new Set();
  for (let i = start; i < rows.length; i++) {
    if (dropped.has(i) || filled(keys[i]) < 2) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (dropped.has(j) || filled(keys[j]) < 2) continue;
      if (covers(keys[i], keys[j])) {
        pairs.push({ keep: i, drop: j });
        dropped.add(j);
      } else if (covers(keys[j], keys[i])) {
        pairs.push({ keep: j, drop: i });
        dropped.add(i);
        break;
      }
    }
  }
  return pairs;
}

/**
 * 生成表格前去掉重复行（见 duplicateRows）；序号原来连着的重新编号。
 * 表里有公式时不删行（删了后面的单元格引用会错位），只返回重复了几行，交给检查提示。
 * @returns {{ rows: any[][], removed: number, duplicates?: number }}
 */
export function dedupeRows(rows, header = true) {
  const drop = new Set(duplicateRows(rows, header).map((x) => x.drop));
  if (!drop.size) return { rows, removed: 0 };
  if (rows.some((r) => r.some((c) => typeof c === 'string' && /^=./.test(c.trim())))) return { rows, removed: 0, duplicates: drop.size };
  const start = header ? 1 : 0;
  const kept = rows.filter((_, ri) => !drop.has(ri));
  for (let ci = 0; header && ci < (rows[0] ?? []).length; ci++) {
    if (!SEQ_HEAD.test(cellKey(rows[0][ci]))) continue;
    const nums = rows.slice(start).map((r) => cellKey(r[ci]));
    if (nums.every((v, i) => v === String(i + 1))) kept.slice(start).forEach((r, i) => { r[ci] = String(i + 1); });
  }
  return { rows: kept, removed: drop.size };
}

/**
 * @param {string} content  CSV / Markdown 表格。“## 名称”分工作表；工作表里还可以有“### 小节”、多张表格和普通文字（说明 / 备注）
 * @param {{ theme: object }} o
 * @returns {Promise<{ blob: Blob, info: { sheets: number, formulas: number, formulaIssues: object[], layout: string, duplicatesRemoved: number, duplicatesKept: number } }>}
 */
export async function makeXlsx(content, { theme }) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = '未央';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true; // Excel / WPS 打开时重新计算全部公式
  const C = theme.colors;
  const official = Boolean(theme.official);
  const headFill = official ? 'FFD9D9D9' : `FF${C.accent}`;
  const headFont = official ? 'FF000000' : 'FFFFFFFF';
  const zebra = `FF${official ? 'FFFFFF' : C.soft}`;
  const titleFill = official ? 'FFFFFFFF' : `FF${C.primary}`;
  const titleFont = official ? 'FF000000' : 'FFFFFFFF';
  const border = { style: 'thin', color: { argb: 'FFBFC7D1' } };
  const borders = { top: border, left: border, bottom: border, right: border };
  const FONT = '微软雅黑';
  let formulas = 0;
  let duplicatesRemoved = 0;
  let duplicatesKept = 0;
  const checked = []; // 每个工作表每格写了什么（公式检查用，行号是 Excel 里真实的行号）

  const sheets = parseBlocks(content);
  if (!sheets.length) sheets.push({ name: 'Sheet1', blocks: [] });
  const used = new Set();
  for (const s of sheets) {
    let name = s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    for (let k = 2; used.has(name); k++) name = `${s.name.slice(0, 28)}(${k})`;
    used.add(name);
    for (const b of s.blocks) {
      if (b.kind !== 'table' || !b.rows.length) continue;
      const d = dedupeRows(b.rows, b.header !== false || looksLikeHeader(b.rows));
      b.rows = d.rows;
      duplicatesRemoved += d.removed;
      duplicatesKept += d.duplicates ?? 0;
    }
    const tables = s.blocks.filter((b) => b.kind === 'table' && b.rows.length);
    // 只有一张表、没有说明和小节：数据表，表头就在第一行（方便筛选、透视）；否则按报表排：大标题、小节、说明
    const report = s.blocks.some((b) => b.kind !== 'table') || tables.length > 1;
    const W = Math.max(1, ...tables.map((t) => Math.max(...t.rows.map((r) => r.length))));
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: !report }] });
    const cells = new Map();
    checked.push({ name, cells, rows: 0, cols: W });
    if (!tables.length && !s.blocks.length) continue;

    // 列宽：只按表格里的字算（说明是整行合并的，不撑宽列）
    const colW = Array.from({ length: W }, (_, ci) => {
      const w = Math.max(4, ...tables.flatMap((t) => t.rows.map((r) => width(r[ci]))));
      return tables.length ? Math.min(50, Math.max(report ? 10 : 8, w + 3)) : 100;
    });
    colW.forEach((w, ci) => { ws.getColumn(ci + 1).width = w; });
    const fullW = colW.reduce((a, b) => a + b, 0);

    let r = 1;
    let firstHeader = 0;
    const band = (text, { font, fill, height, align = 'left', indent = 0 }) => {
      const row = ws.getRow(r);
      if (W > 1) ws.mergeCells(r, 1, r, W);
      const cell = row.getCell(1);
      cell.value = text;
      cells.set(`A${r}`, { value: text });
      cell.font = { name: FONT, ...font };
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true, indent };
      row.height = Math.max(height, linesFor(text, fullW) * (font.size + 5) + 6);
      r++;
    };
    if (report) {
      band(name, { font: { size: 15, bold: true, color: { argb: titleFont } }, fill: titleFill, height: 32, align: 'center' });
      // 紧跟在工作表名下面、第一张表 / 小节之前的文字是副标题
      while (s.blocks[0]?.kind === 'text') band(s.blocks.shift().text, { font: { size: 10, italic: true, color: { argb: 'FF595959' } }, height: 20, align: 'center' });
      r++; // 空一行
    }
    s.blocks.forEach((b, bi) => {
      if (b.kind === 'section') {
        if (bi > 0 && r > 3) r++;
        band(b.text, { font: { size: 11.5, bold: true, color: { argb: official ? 'FF000000' : `FF${C.primary}` } }, fill: official ? undefined : `FF${C.soft}`, height: 24, indent: 0 });
        ws.getRow(r - 1).getCell(1).border = { left: { style: 'thick', color: { argb: official ? 'FF000000' : `FF${C.accent}` } } };
        return;
      }
      if (b.kind === 'text') {
        band(b.text, { font: { size: 10, color: { argb: 'FF404040' } }, height: 18 });
        return;
      }
      if (!b.rows.length) return;
      const header = b.header !== false || looksLikeHeader(b.rows);
      const t = buildTable(b.rows, r, header);
      formulas += t.formulas;
      if (!firstHeader && header) firstHeader = r;
      // 信息表（没有表头）：名目列是第 1 列；四列的是“名目 | 值 | 名目 | 值”
      const labelCol = (ci) => !header && (ci === 0 || (t.cols >= 4 && t.cols % 2 === 0 && ci % 2 === 0));
      const seqCol = (ci) => header && SEQ_HEAD.test(String(b.rows[0][ci] ?? '').trim());
      t.grid.forEach((row, ri) => {
        const xr = ws.getRow(r);
        const total = (ri > 0 || !header) && isTotalRow(row);
        let lines = 1;
        row.forEach((c, ci) => {
          const cell = xr.getCell(ci + 1);
          if (c.formula) cell.value = { formula: c.formula, ...(c.result !== undefined && { result: c.result }) };
          else cell.value = c.value ?? null;
          cells.set(`${colName(ci)}${r}`, c.formula ? { formula: c.formula, result: c.result, xl: cell } : { value: c.value ?? null });
          // 显式公式也沿用同列已知百分比格式，避免权重合计100%显示为1。
          if (c.formula && !c.numFmt) {
            const above = t.grid.slice(header ? 1 : 0, ri).map(previous => previous[ci]).filter(previous => typeof previous?.value === 'number');
            if (above.length && above.every(previous => previous.numFmt?.includes('%'))) c.numFmt = above[0].numFmt;
          }
          if (c.numFmt) cell.numFmt = c.numFmt;
          cell.border = borders;
          cell.font = { name: FONT, size: 10.5 };
          cell.alignment = { vertical: 'middle', wrapText: true, horizontal: seqCol(ci) ? 'center' : typeof c.value === 'number' || c.formula ? 'right' : undefined, indent: !seqCol(ci) && (typeof c.value === 'number' || c.formula) ? 1 : 0 };
          if (labelCol(ci)) {
            cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: official ? 'FF000000' : `FF${C.primary}` } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: official ? 'FFF2F2F2' : `FF${C.soft}` } };
          } else if (header && ri === 0) {
            cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: headFont } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headFill } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          } else if (total) {
            cell.font = { name: FONT, size: 10.5, bold: true };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: official ? 'FFF2F2F2' : `FF${C.soft}` } };
          } else if (header && ri % 2 === 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
          }
          if (typeof c.value === 'string') lines = Math.max(lines, linesFor(c.value, colW[ci] ?? 10));
        });
        xr.height = Math.max(header && ri === 0 ? 24 : 20, lines * 15 + 6);
        r++;
      });
      r++; // 表格之后空一行
    });
    // 冻结到第一张表的表头；只有一张表时加筛选
    if (firstHeader) ws.views = [{ state: 'frozen', ySplit: firstHeader, showGridLines: !report }];
    if (tables.length === 1 && tables[0].header !== false && tables[0].rows.length > 1 && firstHeader) {
      ws.autoFilter = { from: { row: firstHeader, column: 1 }, to: { row: firstHeader, column: Math.max(...tables[0].rows.map((x) => x.length)) } };
    }
    // 打印：宽表横向；所有列缩到一页宽
    ws.pageSetup = { orientation: fullW > 110 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
    if (firstHeader) ws.pageSetup.printTitlesRow = `${firstHeader}:${firstHeader}`;
    checked.at(-1).rows = Math.max(0, ...[...cells.keys()].map((a) => Number(a.match(/\d+$/)[0])));
  }
  // 模型自己写的公式：先算一遍把结果存进去（Excel 打开时照样重算），未央读回、工作区预览时也能看到数
  const computed = evaluateWorkbook(checked);
  for (const sh of checked) {
    for (const [addr, c] of sh.cells) {
      if (!c.formula || c.result !== undefined || !computed.has(`${sh.name}!${addr}`)) continue;
      const v = computed.get(`${sh.name}!${addr}`);
      if (v === null || v === undefined || typeof v === 'object') continue;
      c.result = v;
      c.xl.value = { formula: c.formula, result: v };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return { blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), info: { sheets: sheets.length, formulas, formulaIssues: checkFormulas(checked), layout: sheetLayout(checked), duplicatesRemoved, duplicatesKept } };
}

/** CSV：带 UTF-8 BOM，Excel 双击打开中文不乱码 */
export function makeCsv(content) {
  const sheets = parseSheets(content, { raw: true });
  const rows = dedupeRows(sheets[0]?.rows ?? []).rows;
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = rows.map((r) => r.map(q).join(',')).join('\r\n');
  return new Blob([`﻿${text}\r\n`], { type: 'text/csv;charset=utf-8' });
}

export const withBom = (s) => (String(s).startsWith('﻿') ? String(s) : `﻿${s}`);

