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
import { spreadsheetTokens } from './spreadsheetDesign.js';

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
const DONE = /完成率|达成率|完成比例|执行率|使用率|兑现率/;
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

/** 结算、预算表里能算出来的列：净重 = 毛重 − 皮重；金额 = 数量（净重）× 单价 */
const GROSS = /毛重/;
const TARE = /皮重|筐重|扣重|扣秤|包装重/;
const NET = /净重/;
const QTY = /数量|斤数|件数|吨数|重量|工时|天数|人数/;
const PRICE = /单价|价格|费率/;
const AMOUNT = /金额|货款|应付|应收|结算款|小计/;
const isNum = (c) => typeof c?.value === 'number' || typeof c?.result === 'number';
const valOf = (c) => (typeof c?.value === 'number' ? c.value : typeof c?.result === 'number' ? c.result : null);
/**
 * 模型常把金额、净重手算好填进去（算错了也看不出来）：表头认得出来、两边都是数时改成公式，
 * Excel 里改了数量或单价，金额跟着变。
 * @returns {number} 改成公式的格子数
 */
function deriveColumns(headers, dataRows) {
  const find = (re, not) => headers.findIndex((h) => re.test(h) && !(not && not.test(h)));
  let n = 0;
  const gross = find(GROSS);
  const tare = find(TARE);
  const net = find(NET);
  const set = (row, ci, formula, result, numFmt) => { row[ci] = { formula, result: Math.round(result * 1e6) / 1e6, numFmt: row[ci]?.numFmt ?? numFmt }; n++; };
  if (gross >= 0 && tare >= 0 && net >= 0) {
    for (const { row, r } of dataRows) {
      if (row[net]?.formula || !isNum(row[gross])) continue;
      set(row, net, `${colName(gross)}${r}-${colName(tare)}${r}`, valOf(row[gross]) - (valOf(row[tare]) ?? 0), row[gross].numFmt ?? '#,##0.00');
    }
  }
  const qty = net >= 0 ? net : find(QTY, /单价|金额|毛重|皮重/);
  const price = find(PRICE);
  const amount = find(AMOUNT, /单价|率|占比/);
  if (qty >= 0 && price >= 0 && amount >= 0 && amount !== qty && amount !== price) {
    for (const { row, r } of dataRows) {
      if (row[amount]?.formula || !isNum(row[qty]) || !isNum(row[price])) continue;
      set(row, amount, `ROUND(${colName(qty)}${r}*${colName(price)}${r},2)`, Math.round(valOf(row[qty]) * valOf(row[price]) * 100) / 100, row[price].numFmt?.includes('¥') ? row[price].numFmt : '#,##0.00');
    }
  }
  return n;
}

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
  const derived = header ? deriveColumns(headers, dataRows) : 0;
  const numericCols = [...Array(cols).keys()].filter((ci) => dataRows.some(({ row }) => typeof row[ci]?.value === 'number' || typeof row[ci]?.result === 'number'));
  // 每行都是模型写的公式（如“差异 = 实际 − 预算”）的列：合计行也要加起来
  const formulaCols = [...Array(cols).keys()].filter((ci) => !numericCols.includes(ci) && dataRows.length > 1 && dataRows.every(({ row }) => row[ci]?.formula || typeof row[ci]?.value === 'number') && dataRows.some(({ row }) => row[ci]?.formula));
  const shareCols = new Set([...Array(cols).keys()].filter((ci) => SHARE.test(headers[ci] ?? '')));
  const growthCols = new Set([...Array(cols).keys()].filter((ci) => !shareCols.has(ci) && (GROWTH.test(headers[ci] ?? '') || DONE.test(headers[ci] ?? ''))));
  let formulas = 0;
  // 合计行：数字列 = SUM(上面的数据行)（先算合计，后面的增长率、占比才能用上合计的数）
  for (const { row, r } of bodyRows) {
    if (!isTotalRow(row)) continue;
    const above = dataRows.filter((d) => d.r < r);
    if (!above.length) continue;
    for (const ci of [...numericCols, ...formulaCols]) {
      // 单价、费率、序号加起来没有意义
      if (ci === 0 || growthCols.has(ci) || shareCols.has(ci) || row[ci]?.formula || PRICE.test(headers[ci] ?? '') || SEQ_HEAD.test(String(headers[ci] ?? '').trim())) continue;
      const from = above[0].r; const to = above.at(-1).r;
      const sum = above.reduce((n, d) => n + (typeof d.row[ci]?.value === 'number' ? d.row[ci].value : typeof d.row[ci]?.result === 'number' ? d.row[ci].result : 0), 0);
      const fmt = above.find((d) => d.row[ci]?.numFmt)?.row[ci].numFmt ?? '#,##0';
      if (fmt.includes('%')) continue; // 百分比列加总没有意义
      // 上面是模型写的公式（还没算出结果）：结果留给后面统一计算，不填一个错的 0
      row[ci] = { formula: `SUM(${colName(ci)}${from}:${colName(ci)}${to})`, ...(!formulaCols.includes(ci) && { result: Math.round(sum * 1e6) / 1e6 }), numFmt: fmt };
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
  return { grid, cols, formulas, derived };
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

const INPUT_FONT = 'FF1F4E9A';
const CALC_FILL = 'FFF1F3F6';
const LEGEND = '说明：蓝色数字是录入的，灰底格子是公式算的；改录入的数，结果会跟着变';
/** 这张表会不会自动补出公式（金额 = 数量 × 单价、净重 = 毛重 − 皮重） */
function wouldDerive(rows) {
  const h = (rows[0] ?? []).map((x) => String(x ?? ''));
  const has = (re, not) => h.some((x) => re.test(x) && !(not && not.test(x)));
  return (has(GROSS) && has(TARE) && has(NET)) || ((has(QTY, /单价|金额/) || has(NET)) && has(PRICE) && has(AMOUNT, /单价|率|占比/)) || h.some((x) => TOTAL.test(x)) || rows.some((r) => isTotalRow(r.map((v) => ({ value: v }))));
}

const STATUS = /状态|进度$|是否|结清|付款情况/;
const DUE = /截止|到期|计划完成|交付日期|完成时限|应完成/;
const BAD = ['逾期', '超期', '延期', '未完成', '未付', '欠款', '异常'];
const GOOD = ['已完成', '已结清', '已付', '已交付', '正常'];
const DEFAULT_STATUS = {
  ledger: ['未开始', '进行中', '已完成', '已逾期'],
  settlement: ['未付', '部分付', '已付'],
  budget: ['待审批', '已批准', '已执行']
};
const fillStyle = (argb) => ({ fill: { type: 'pattern', pattern: 'solid', bgColor: { argb } } });
/**
 * 按表头加条件格式和下拉选项（结算、台账、预算、分析表的常用规矩）：
 *   负数标红；增长率负红正绿；完成率不到 100% 标橙；实际超过预算标红；状态列“逾期 / 未付”红底、“已完成 / 已付”绿底；
 *   截止日期已过、状态还没完成的标橙；状态列、是否列给下拉选项。
 */
function tableRules(ws, { headers, first, last, grid, kind }) {
  const ref = (ci) => `${colName(ci)}${first}:${colName(ci)}${last}`;
  const add = (ci, rules) => ws.addConditionalFormatting({ ref: ref(ci), rules });
  const red = { font: { color: { argb: 'FFC00000' } } };
  const green = { font: { color: { argb: 'FF2E7D32' } } };
  const body = grid.slice(1);
  const numeric = (ci) => body.some((row) => typeof row[ci]?.value === 'number' || row[ci]?.formula);
  headers.forEach((h, ci) => {
    if (!numeric(ci) || SEQ_HEAD.test(h.trim())) return;
    if (GROWTH.test(h)) add(ci, [{ type: 'cellIs', operator: 'lessThan', formulae: [0], style: red, priority: 1 }, { type: 'cellIs', operator: 'greaterThan', formulae: [0], style: green, priority: 2 }]);
    else if (DONE.test(h)) {
      add(ci, [{ type: 'cellIs', operator: 'lessThan', formulae: [1], style: { font: { color: { argb: 'FFD9822B' } } }, priority: 1 }]);
      if (kind === 'analysis') add(ci, [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FF8DB4E2' }, priority: 3 }]);
    } else if (/金额|差异|利润|增减|结余|余额|差额|盈亏/.test(h) || kind === 'settlement' || kind === 'budget') {
      add(ci, [{ type: 'cellIs', operator: 'lessThan', formulae: [0], style: red, priority: 1 }]);
    }
    if (kind === 'analysis' && SHARE.test(h)) add(ci, [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF8DB4E2' }, priority: 3 }]);
  });
  // 实际超过预算 / 计划：标红
  const plan = headers.findIndex((h) => /预算|计划/.test(h) && !/率|差/.test(h));
  const actual = headers.findIndex((h) => /实际|已用|执行数/.test(h) && !/率|差/.test(h));
  if (plan >= 0 && actual >= 0 && numeric(plan) && numeric(actual)) {
    add(actual, [{ type: 'expression', formulae: [`AND(ISNUMBER(${colName(actual)}${first}),${colName(actual)}${first}>${colName(plan)}${first})`], style: { ...fillStyle('FFFDE2E1'), ...red }, priority: 1 }]);
  }
  const status = headers.findIndex((h) => STATUS.test(h));
  if (status >= 0) {
    // 用公式规则（SEARCH）而不是“文本包含”规则：后者 ExcelJS 写出来缺属性，WPS / LibreOffice 不认
    const has = (words) => `OR(${words.map((w) => `ISNUMBER(SEARCH("${w}",${colName(status)}${first}))`).join(',')})`;
    add(status, [
      { type: 'expression', formulae: [has(BAD)], style: { ...fillStyle('FFFDE2E1'), ...red }, priority: 1 },
      { type: 'expression', formulae: [has(GOOD)], style: { ...fillStyle('FFE6F4EA'), ...green }, priority: 2 }
    ]);
    // 下拉选项：表里已有的状态 + 这类表常用的状态（状态种类太多的不加，免得卡死录入）
    const seen = [...new Set(body.map((row) => String(row[status]?.value ?? '').trim()).filter(Boolean))];
    const yesNo = /是否/.test(headers[status]);
    const options = yesNo ? ['是', '否'] : [...new Set([...(DEFAULT_STATUS[kind] ?? []), ...seen])];
    if (options.length >= 2 && options.length <= 8 && options.join(',').length < 200 && (yesNo || seen.length <= 6)) {
      for (let r = first; r <= last; r++) ws.getCell(`${colName(status)}${r}`).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: [`"${options.join(',')}"`] };
    }
  }
  // 截止日期过了、状态还不是完成：整格标橙
  const due = headers.findIndex((h) => DUE.test(h));
  if (due >= 0 && body.some((row) => row[due]?.value instanceof Date)) {
    const D = `${colName(due)}${first}`;
    const done = status >= 0 ? `,ISERROR(SEARCH("完成",${colName(status)}${first}))` : '';
    add(due, [{ type: 'expression', formulae: [`AND(ISNUMBER(${D}),${D}<TODAY()${done})`], style: { ...fillStyle('FFFFE8CC'), font: { color: { argb: 'FFB45309' } } }, priority: 1 }]);
  }
}

/**
 * @param {string} content  CSV / Markdown 表格。“## 名称”分工作表；工作表里还可以有“### 小节”、多张表格和普通文字（说明 / 备注）
 * @param {{ theme: object, kind?: string }} o  kind：settlement 结算 / ledger 台账 / budget 预算 / analysis 分析 / general（documentDesign.js 判断）
 * @returns {Promise<{ blob: Blob, info: { sheets: number, formulas: number, formulaIssues: object[], layout: string, duplicatesRemoved: number, duplicatesKept: number } }>}
 */
export async function makeXlsx(content, { theme, kind = 'general', sheetStyle = '', typography = {} }) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = '未央';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true; // Excel / WPS 打开时重新计算全部公式
  const C = theme.colors;
  const official = Boolean(theme.official);
  const T = { ...spreadsheetTokens(sheetStyle, theme, kind) };
  if (typography.body?.size) T.bodySize = typography.body.size;
  if (typography.title?.size) { T.titleSize = typography.title.size; T.headSize = typography.title.size; }
  const { headFill, headFont, zebra, titleFill, titleFont } = T;
  const border = { style: 'thin', color: { argb: 'FFBFC7D1' } };
  const borders = T.rulesOnly ? { bottom: { style: 'hair', color: { argb: 'FFE0E6ED' } } } : { top: border, left: border, bottom: border, right: border };
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
    const showGridLines = !report && ['business', 'ledger'].includes(T.style);
    const ws = wb.addWorksheet(name, { views: [{ showGridLines }] });
    const cells = new Map();
    checked.push({ name, cells, rows: 0, cols: W });
    if (!tables.length && !s.blocks.length) continue;

    // 列宽：只按表格里的字算（说明是整行合并的，不撑宽列）
    const colW = Array.from({ length: W }, (_, ci) => {
      const w = Math.max(4, ...tables.flatMap((t) => t.rows.map((r) => width(r[ci]))));
      return tables.length ? Math.min(50, Math.max(report ? 10 : 8, w + 3)) : 100;
    });
    // 短报表也利用A4可打印宽度；只展开列宽，不插行/列或重写公式，普通数据表维持原逻辑。
    const naturalWidth = colW.reduce((a, b) => a + b, 0);
    if (report && W > 1 && naturalWidth < T.reportWidth) {
      colW.forEach((value, ci) => { colW[ci] = Math.min(50, value * T.reportWidth / naturalWidth); });
    }
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
      if (typography.body?.size && font.size !== T.titleSize) cell.font = { ...cell.font, size: typography.body.size };
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true, indent };
      row.height = Math.max(height, linesFor(text, fullW) * (font.size + 5) + 6);
      r++;
    };
    if (report) {
      band(name, { font: { size: T.titleSize, bold: true, color: { argb: titleFont } }, fill: titleFill, height: 32, align: T.titleAlign });
      // 紧跟在工作表名下面、第一张表 / 小节之前的文字是副标题
      while (s.blocks[0]?.kind === 'text') band(s.blocks.shift().text, { font: { size: 10, italic: true, color: { argb: 'FF595959' } }, height: 20, align: 'center' });
      // 有公式的报表：标题格加批注说明怎么看（不插行：模型写的公式按固定行号引用，插一行就全错位）
      if (s.blocks.some((b) => b.kind === 'table' && (b.rows.some((row) => row.some((c) => /^=./.test(String(c ?? '').trim()))) || wouldDerive(b.rows)))) ws.getRow(1).getCell(1).note = LEGEND;
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
          cell.font = { name: FONT, size: T.bodySize };
          cell.alignment = { vertical: 'middle', wrapText: true, horizontal: seqCol(ci) ? 'center' : typeof c.value === 'number' || c.formula ? 'right' : undefined, indent: !seqCol(ci) && (typeof c.value === 'number' || c.formula) ? 1 : 0 };
          if (labelCol(ci)) {
            cell.font = { name: FONT, size: T.bodySize, bold: true, color: { argb: official ? 'FF000000' : `FF${C.primary}` } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: official ? 'FFF2F2F2' : `FF${C.soft}` } };
          } else if (header && ri === 0) {
            cell.font = { name: FONT, size: T.headSize, bold: true, color: { argb: headFont } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headFill } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          } else if (total) {
            cell.font = { name: FONT, size: T.bodySize, bold: true, color: { argb: T.totalFont } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.totalFill } };
          } else if (header && ri % 2 === 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
          }
          // 录入的数和公式算的数分开：录入是蓝字，公式是灰底（表里有公式时才分，免得满屏颜色）
          if (t.formulas && header && ri > 0 && !total && !labelCol(ci) && !seqCol(ci)) {
            if (c.formula) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CALC_FILL } };
            else if (typeof c.value === 'number') cell.font = { name: FONT, size: T.bodySize, color: { argb: INPUT_FONT } };
          }
          if (typeof c.value === 'string') lines = Math.max(lines, linesFor(c.value, colW[ci] ?? 10));
        });
        xr.height = Math.max(header && ri === 0 ? T.headHeight : T.bodyHeight, lines * (T.style === 'business' ? 15 : T.bodySize + 4) + (T.style === 'ledger' ? 4 : 6));
        r++;
      });
      if (header) {
        const top = r - t.grid.length;
        const rows = t.grid.slice(1).map((row, k) => ({ row, r: top + 1 + k })).filter(({ row }) => !isTotalRow(row));
        if (rows.length) tableRules(ws, { headers: b.rows[0].map((h) => String(h ?? '')), first: rows[0].r, last: rows.at(-1).r, grid: t.grid, kind });
        if (t.formulas && !report) ws.getRow(top).getCell(1).note = LEGEND;
      }
      r++; // 表格之后空一行
    });
    // 冻结到第一张表的表头；只有一张表时加筛选
    if (firstHeader) ws.views = [{ state: 'frozen', ySplit: firstHeader, showGridLines }];
    if (tables.length === 1 && tables[0].header !== false && tables[0].rows.length > 1 && firstHeader) {
      ws.autoFilter = { from: { row: firstHeader, column: 1 }, to: { row: firstHeader + tables[0].rows.length - 1, column: Math.max(...tables[0].rows.map((x) => x.length)) } };
    }
    // 打印：宽表横向；所有列缩到一页宽
    ws.pageSetup = { orientation: fullW > 110 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
    if (firstHeader) ws.pageSetup.printTitlesRow = `${firstHeader}:${firstHeader}`;
    // 打印区域就是写了东西的范围；页脚写页码
    const lastRow = Math.max(1, ...[...cells.keys()].map((a) => Number(a.match(/\d+$/)[0])));
    ws.pageSetup.printArea = `A1:${colName(W - 1)}${lastRow}`;
    const calc = [...cells.values()].some((c) => c.formula);
    ws.headerFooter = { oddHeader: `&L&9${name}${calc ? '&R&9蓝字为录入，灰底为公式' : ''}`, oddFooter: '&C&9第 &P 页 / 共 &N 页' };
    // 宽表（结算、台账常见）：左边的名称列也冻结，横着拉时还看得到是谁
    if (firstHeader && W > 6) {
      const nameCol = tables[0].rows[0].findIndex((h) => /姓名|名称|户名|客户|项目|品名|事项|任务/.test(String(h ?? '')));
      if (nameCol >= 0 && nameCol <= 2) ws.views = [{ state: 'frozen', ySplit: firstHeader, xSplit: nameCol + 1, showGridLines }];
    }
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
  if (Object.keys(typography).length) for (const sheet of wb.worksheets) sheet.eachRow(row => { let max = 0; row.eachCell(cell => { max = Math.max(max, cell.font?.size || 0); }); if (max) row.height = Math.max(row.height || 0, max * 1.5 + 6); });
  const buf = await wb.xlsx.writeBuffer();
  return { blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), info: { sheets: sheets.length, formulas, formulaIssues: checkFormulas(checked), layout: sheetLayout(checked), duplicatesRemoved, duplicatesKept, sheetStyle: T.style } };
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

