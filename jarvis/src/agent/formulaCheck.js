/**
 * Excel 公式检查（生成 xlsx 之后做，不花钱）：
 *   函数名拼错（打开是 #NAME?）、引用了不存在的工作表（#REF!）、括号不配对、
 *   公式引用自己（循环引用）、引用到表格外面的空白格、求和范围里一个数字都没有（多半引到了表头或错列）、
 *   除数是空格子或 0 又没有用 IFERROR 包住（打开是 #DIV/0!）。
 * 公式里的行号是排版后真实的 Excel 行号（报表模式有大标题、小节，和 Markdown 里的行不一样），
 * 所以在 makeXlsx 写完单元格后，拿记下的“每格是什么”来查。
 */

// 常用的 Excel / WPS 函数（不在表里的当拼错处理）
const FUNCS = new Set(`
ABS ACOS AND ASIN ATAN ATAN2 AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS CEILING CEILING.MATH CHAR CHOOSE CLEAN CODE COLUMN COLUMNS CONCAT CONCATENATE
CORREL COS COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS DATE DATEDIF DATEVALUE DAY DAYS EDATE EOMONTH EXACT EXP FILTER FIND FIXED FLOOR FLOOR.MATH
FORECAST FREQUENCY GEOMEAN HLOOKUP HOUR HYPERLINK IF IFERROR IFNA IFS INDEX INDIRECT INT IRR ISBLANK ISERROR ISNA ISNUMBER ISTEXT LARGE LEFT LEN
LN LOG LOG10 LOOKUP LOWER MATCH MAX MAXA MAXIFS MEDIAN MID MIN MINA MINIFS MINUTE MOD MODE MONTH MROUND N NETWORKDAYS NOT NOW NPV OFFSET OR
PERCENTILE PI PMT POWER PRODUCT PROPER QUARTILE RAND RANDBETWEEN RANK RANK.EQ RATE REPLACE REPT RIGHT ROUND ROUNDDOWN ROUNDUP ROW ROWS SEARCH
SECOND SEQUENCE SIGN SIN SMALL SORT SORTBY SQRT STDEV STDEV.P STDEV.S STDEVP SUBSTITUTE SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SWITCH TAN TEXT
TEXTJOIN TIME TODAY TRANSPOSE TREND TRIM TRUNC UNIQUE UPPER VALUE VAR VAR.P VAR.S VLOOKUP WEEKDAY WEEKNUM WORKDAY XLOOKUP XMATCH YEAR YEARFRAC
`.trim().split(/\s+/));
// 这些函数的参数是“一堆数”：范围里一个数字都没有就不对
const NUMERIC = /^(SUM|AVERAGE|MAX|MIN|PRODUCT|MEDIAN|STDEV|STDEV\.S|STDEV\.P|VAR|COUNT)$/;

export const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// 'Sheet 名'!A1:B2 / Sheet1!A1 / A1:B2 / A1（$ 绝对引用照认）
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_一-鿿][\w.一-鿿]*))!`;
const CELL = String.raw`\$?([A-Za-z]{1,3})\$?(\d{1,7})`;
const REF = new RegExp(String.raw`(?<![\w.$])(?:${SHEET})?${CELL}(?::${CELL})?(?![\w(])`, 'g');

/** 去掉字符串常量（"..."），免得把文字里的“A1”当引用 */
const stripStrings = (f) => String(f).replace(/"(?:[^"]|"")*"/g, '""');

/** 公式里的引用：[{ sheet, c1, r1, c2, r2, text, index }]（行列从 0 / 1 开始：列 0 起，行 1 起） */
export function refsOf(formula) {
  const f = stripStrings(formula);
  const out = [];
  for (const m of f.matchAll(REF)) {
    const sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2] ?? null;
    const c1 = colIndex(m[3]); const r1 = Number(m[4]);
    const c2 = m[5] ? colIndex(m[5]) : c1; const r2 = m[6] ? Number(m[6]) : r1;
    if (c1 > 16383 || c2 > 16383) continue; // 超出 XFD 的“引用”其实是别的东西
    out.push({ sheet, c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2), text: m[0], index: m.index });
  }
  return out;
}

/** 某个函数调用的参数文本：从“SUM(”后面到配对的右括号 */
function callsOf(formula) {
  const f = stripStrings(formula);
  const out = [];
  for (const m of f.matchAll(/([A-Za-z][A-Za-z0-9.]*)\s*\(/g)) {
    let depth = 0; let k = m.index + m[0].length - 1;
    for (; k < f.length; k++) { if (f[k] === '(') depth++; else if (f[k] === ')' && --depth === 0) break; }
    out.push({ name: m[1].toUpperCase(), args: f.slice(m.index + m[0].length, k), index: m.index });
  }
  return out;
}

/**
 * @param {Array<{ name: string, cells: Map<string, { value?: any, formula?: string }>, rows: number, cols: number }>} sheets
 *        cells 的键是“A1”式地址；rows / cols 是用到的行数、列数
 * @returns {Array<{ level: 'error'|'warn', text: string, sheet: string, cell: string, formula: string }>}
 */
export function checkFormulas(sheets, { max = 12 } = {}) {
  const issues = [];
  const byName = new Map(sheets.map((s) => [s.name, s]));
  const seen = new Set();
  const add = (level, s, addr, formula, text) => {
    const key = `${s.name}!${addr}:${text}`;
    if (seen.has(key) || issues.length >= max) return;
    seen.add(key);
    issues.push({ level, text: `工作表“${s.name}”${addr} 的公式 =${formula}：${text}`, sheet: s.name, cell: addr, formula });
  };
  const isNum = (c) => c && (typeof c.value === 'number' || c.formula);
  const isEmpty = (c) => !c || (!c.formula && (c.value === null || c.value === undefined || c.value === ''));
  for (const s of sheets) {
    for (const [addr, cell] of s.cells) {
      if (!cell.formula) continue;
      const f = String(cell.formula).replace(/^=/, '');
      const at = addr.match(/^([A-Z]+)(\d+)$/);
      const self = { c: colIndex(at[1]), r: Number(at[2]) };
      const plainF = stripStrings(f);
      let depth = 0; let bad = false;
      for (const ch of plainF) { if (ch === '(') depth++; else if (ch === ')' && --depth < 0) bad = true; }
      if (bad || depth !== 0) { add('error', s, addr, f, '括号不配对，Excel 打不开这个公式'); continue; }
      for (const { name } of callsOf(f)) {
        const n = name.replace(/^_XLFN\./, '');
        if (!FUNCS.has(n)) add('error', s, addr, f, `函数 ${name} 不认识（拼错了？），打开会显示 #NAME?`);
      }
      const guarded = /\b(IFERROR|IFNA|IF)\s*\(/i.test(plainF);
      for (const ref of refsOf(f)) {
        const target = ref.sheet ? byName.get(ref.sheet) : s;
        if (!target) { add('error', s, addr, f, `引用的工作表“${ref.sheet}”不存在，打开会显示 #REF!`); continue; }
        if (target === s && self.c >= ref.c1 && self.c <= ref.c2 && self.r >= ref.r1 && self.r <= ref.r2) {
          add('error', s, addr, f, `引用了自己（${ref.text}），是循环引用，算不出结果`);
          continue;
        }
        const cellsIn = [];
        for (let r = ref.r1; r <= Math.min(ref.r2, ref.r1 + 5000); r++) for (let c = ref.c1; c <= ref.c2; c++) cellsIn.push(target.cells.get(`${colName(c)}${r}`));
        const outside = ref.r2 > target.rows || ref.c2 >= target.cols;
        if (cellsIn.every(isEmpty)) {
          add('error', s, addr, f, `引用的 ${ref.text} ${outside ? `在表格外面（表格只到第 ${target.rows} 行、${colName(target.cols - 1)} 列）` : '全是空格子'}，算出来不对`);
          continue;
        }
        if (outside) add('warn', s, addr, f, `引用的 ${ref.text} 有一部分在表格外面（表格只到第 ${target.rows} 行、${colName(target.cols - 1)} 列）`);
      }
      // 求和 / 平均……的范围里一个数字都没有：多半引到了表头、序号文字或错列
      for (const call of callsOf(f)) {
        if (!NUMERIC.test(call.name)) continue;
        const refs = refsOf(call.args).filter((x) => x.c1 !== x.c2 || x.r1 !== x.r2);
        for (const ref of refs) {
          const target = ref.sheet ? byName.get(ref.sheet) : s;
          if (!target) continue;
          const cellsIn = [];
          for (let r = ref.r1; r <= Math.min(ref.r2, ref.r1 + 5000); r++) for (let c = ref.c1; c <= ref.c2; c++) cellsIn.push(target.cells.get(`${colName(c)}${r}`));
          if (cellsIn.some((c) => !isEmpty(c)) && !cellsIn.some(isNum)) add('error', s, addr, f, `${call.name} 的范围 ${ref.text} 里一个数字都没有（引到了表头或文字列？）`);
        }
      }
      // 除数：单个格子是空的或 0，又没有 IFERROR / IF 兜底
      if (!guarded) {
        for (const m of plainF.matchAll(new RegExp(String.raw`/\s*(?:${SHEET})?${CELL}(?![\w(:])`, 'g'))) {
          const sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2] ?? null;
          const target = sheet ? byName.get(sheet) : s;
          const c = target?.cells.get(`${m[3].toUpperCase()}${m[4]}`);
          if (target && (isEmpty(c) || c.value === 0)) add('error', s, addr, f, `除数 ${m[0].replace(/^\/\s*/, '')} 是${isEmpty(c) ? '空格子' : ' 0'}，打开会显示 #DIV/0!（可以用 IFERROR 包住）`);
        }
      }
    }
  }
  return issues;
}

/** 给模型看的排版：每个工作表每行在 Excel 里的行号和内容，改公式时对照 */
export function sheetLayout(sheets, { maxRows = 60 } = {}) {
  return sheets.map((s) => {
    const lines = [`工作表“${s.name}”（${s.rows} 行 × ${s.cols} 列）：`];
    for (let r = 1; r <= Math.min(s.rows, maxRows); r++) {
      const row = [];
      for (let c = 0; c < s.cols; c++) {
        const cell = s.cells.get(`${colName(c)}${r}`);
        if (!cell || (cell.value == null && !cell.formula) || cell.value === '') continue;
        const v = cell.formula ? `=${cell.formula}` : cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.value).slice(0, 24);
        row.push(`${colName(c)}${r}：${v}`);
      }
      if (row.length) lines.push(`  ${row.join(' | ')}`);
    }
    if (s.rows > maxRows) lines.push(`  …（共 ${s.rows} 行）`);
    return lines.join('\n');
  }).join('\n');
}
