/**
 * 小型公式计算：生成 xlsx 时把模型自己写的公式先算一遍，结果一起存进文件。
 * Excel / WPS 打开时本来就会重算；存好结果是为了在未央自己的工作区预览、或未央读回这个表时也能看到数，
 * 不会因为看到空格子就以为“公式没写进去”而返工。
 *
 * 支持：数字、文字、单元格和范围引用（含跨工作表）、+ - * / ^ & 和比较、括号、
 *       SUM AVERAGE MAX MIN COUNT COUNTA ROUND ROUNDUP ROUNDDOWN ABS IF IFERROR AND OR INDEX MATCH SUMIF COUNTIF。
 * 算不了的（不认识的函数、写法太复杂）返回 undefined，不存结果，交给 Excel 打开时去算。
 */
import { colName } from './formulaCheck.js';

const ERR = { div0: '#DIV/0!', value: '#VALUE!', ref: '#REF!', na: '#N/A' };
const isErr = (v) => typeof v === 'string' && /^#(DIV\/0!|VALUE!|REF!|N\/A|NAME\?)$/.test(v);
class Unsupported extends Error {}

function tokenize(src) {
  const out = [];
  const re = /\s*(?:("(?:[^"]|"")*")|('(?:[^']|'')+'!|[A-Za-z_一-鿿][\w.一-鿿]*!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![\w(])|(\d+(?:\.\d+)?%?)|([A-Za-z][A-Za-z0-9.]*)\s*\(|(<=|>=|<>|[-+*/^&=<>(),:;%]))/y;
  let m;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m || m[0] === '') { if (/^\s+$/.test(src.slice(i))) break; throw new Unsupported(src.slice(i, i + 10)); }
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'str', v: m[1].slice(1, -1).replace(/""/g, '"') });
    else if (m[3] !== undefined) out.push({ t: 'ref', sheet: m[2] ? m[2].slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : null, v: m[3].replace(/\$/g, '').toUpperCase() });
    else if (m[4] !== undefined) out.push({ t: 'num', v: m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]) });
    else if (m[5] !== undefined) out.push({ t: 'fn', v: m[5].toUpperCase().replace(/^_XLFN\./, '') });
    else out.push({ t: 'op', v: m[6] });
  }
  return out;
}

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const split = (a) => { const m = a.match(/^([A-Z]+)(\d+)$/); return { c: colIndex(m[1]), r: Number(m[2]) }; };

/**
 * @param {Array<{ name: string, cells: Map<string, { value?: any, formula?: string }> }>} sheets
 * @returns {Map<string, any>} “工作表!A1” → 算出来的值（只含能算的公式）
 */
export function evaluateWorkbook(sheets) {
  const byName = new Map(sheets.map((s) => [s.name, s]));
  const results = new Map();
  const busy = new Set();

  const cellValue = (sheet, addr) => {
    const key = `${sheet.name}!${addr}`;
    if (results.has(key)) return results.get(key);
    const c = sheet.cells.get(addr);
    if (!c) return null;
    if (!c.formula) return c.value instanceof Date ? c.value : c.value ?? null;
    if (busy.has(key)) throw new Unsupported('循环引用');
    busy.add(key);
    try {
      const v = evalFormula(sheet, c.formula);
      results.set(key, v);
      return v;
    } finally { busy.delete(key); }
  };

  const evalFormula = (sheet, formula) => {
    const toks = tokenize(String(formula).replace(/^=/, ''));
    let p = 0;
    const peek = () => toks[p];
    const eat = (v) => { if (toks[p]?.v !== v) throw new Unsupported(`缺少 ${v}`); p++; };
    const range = (tok) => {
      const s = tok.sheet ? byName.get(tok.sheet) : sheet;
      if (!s) return ERR.ref;
      const [a, b = a] = tok.v.split(':');
      const A = split(a); const B = split(b);
      const rows = [];
      for (let r = Math.min(A.r, B.r); r <= Math.max(A.r, B.r); r++) {
        const row = [];
        for (let c = Math.min(A.c, B.c); c <= Math.max(A.c, B.c); c++) row.push(cellValue(s, `${colName(c)}${r}`));
        rows.push(row);
      }
      return { range: true, rows };
    };
    const scalar = (v) => {
      if (v?.range) { if (v.rows.length === 1 && v.rows[0].length === 1) return v.rows[0][0]; throw new Unsupported('范围不能当单个值'); }
      return v;
    };
    const num = (v) => {
      v = scalar(v);
      if (isErr(v)) throw Object.assign(new Error(v), { excel: v });
      if (v === null || v === '') return 0;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number') return v;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      throw Object.assign(new Error(ERR.value), { excel: ERR.value });
    };
    const flat = (args) => args.flatMap((a) => (a?.range ? a.rows.flat() : [a]));
    const numbers = (args) => flat(args).filter((v) => { if (isErr(v)) throw Object.assign(new Error(v), { excel: v }); return typeof v === 'number'; });
    const matches = (crit) => {
      const m = String(crit).match(/^(<=|>=|<>|<|>|=)?(.*)$/);
      const op = m[1] || '=';
      const rhs = Number.isFinite(Number(m[2])) && m[2] !== '' ? Number(m[2]) : m[2];
      return (v) => {
        const l = typeof rhs === 'number' ? Number(v) : String(v ?? '');
        return { '=': l === rhs, '<>': l !== rhs, '<': l < rhs, '>': l > rhs, '<=': l <= rhs, '>=': l >= rhs }[op];
      };
    };
    const FN = {
      SUM: (a) => numbers(a).reduce((x, y) => x + y, 0),
      AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw Object.assign(new Error(ERR.div0), { excel: ERR.div0 }); return n.reduce((x, y) => x + y, 0) / n.length; },
      MAX: (a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
      MIN: (a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
      COUNT: (a) => numbers(a).length,
      COUNTA: (a) => flat(a).filter((v) => v !== null && v !== '').length,
      ABS: (a) => Math.abs(num(a[0])),
      ROUND: (a) => { const k = 10 ** num(a[1] ?? 0); return Math.round(num(a[0]) * k) / k; },
      ROUNDUP: (a) => { const k = 10 ** num(a[1] ?? 0); const x = num(a[0]); return Math.sign(x) * Math.ceil(Math.abs(x) * k) / k; },
      ROUNDDOWN: (a) => { const k = 10 ** num(a[1] ?? 0); const x = num(a[0]); return Math.sign(x) * Math.floor(Math.abs(x) * k) / k; },
      AND: (a) => flat(a).every((v) => Boolean(num(v))),
      OR: (a) => flat(a).some((v) => Boolean(num(v))),
      INDEX: (a) => {
        const r = a[0]; if (!r?.range) throw new Unsupported('INDEX');
        const i = num(a[1]); const j = a[2] === undefined ? 1 : num(a[2]);
        const single = r.rows.length === 1 && a[2] === undefined;
        const v = single ? r.rows[0][i - 1] : r.rows[i - 1]?.[j - 1];
        if (v === undefined) throw Object.assign(new Error(ERR.ref), { excel: ERR.ref });
        return v;
      },
      MATCH: (a) => {
        if ((a[2] === undefined ? 1 : num(a[2])) !== 0) throw new Unsupported('MATCH 只算精确匹配');
        const want = scalar(a[0]);
        const list = a[1]?.range ? a[1].rows.flat() : [];
        const k = list.findIndex((v) => v === want || (typeof want === 'number' && Number(v) === want) || String(v) === String(want));
        if (k < 0) throw Object.assign(new Error(ERR.na), { excel: ERR.na });
        return k + 1;
      },
      SUMIF: (a) => {
        const test = matches(scalar(a[1]));
        const keys = a[0]?.range ? a[0].rows.flat() : [];
        const vals = (a[2] ?? a[0])?.range ? (a[2] ?? a[0]).rows.flat() : [];
        return keys.reduce((s, k, i) => (test(k) && typeof vals[i] === 'number' ? s + vals[i] : s), 0);
      },
      COUNTIF: (a) => { const test = matches(scalar(a[1])); return (a[0]?.range ? a[0].rows.flat() : []).filter(test).length; }
    };
    // 递归下降：比较 < 连接 & < 加减 < 乘除 < 乘方 < 一元 < 基本项
    const primary = () => {
      const t = toks[p++];
      if (!t) throw new Unsupported('公式不完整');
      if (t.t === 'num' || t.t === 'str') return t.v;
      if (t.t === 'ref') return range(t);
      if (t.t === 'op' && t.v === '(') { const v = compare(); eat(')'); return v; }
      if (t.t === 'op' && (t.v === '-' || t.v === '+')) { const v = num(power()); return t.v === '-' ? -v : v; }
      if (t.t === 'fn') {
        const args = [];
        const lazy = t.v === 'IF' || t.v === 'IFERROR';
        if (peek()?.v !== ')') {
          for (;;) {
            if (lazy) {
              // IF / IFERROR：参数出错时也要能接住，所以每个参数单独算
              const start = p;
              let depth = 0;
              while (p < toks.length && !(depth === 0 && (toks[p].v === ',' || toks[p].v === ')'))) { if (toks[p].v === '(' || toks[p].t === 'fn') depth++; else if (toks[p].v === ')') depth--; p++; }
              args.push(toks.slice(start, p));
            } else args.push(compare());
            if (peek()?.v === ',') { p++; continue; }
            break;
          }
        }
        eat(')');
        if (lazy) {
          const run = (sub) => {
            if (!sub || !sub.length) return 0;
            const saveT = toks.splice(0, toks.length, ...sub);
            const saveP = p;
            p = 0;
            try { return compare(); } finally { toks.splice(0, toks.length, ...saveT); p = saveP; }
          };
          if (t.v === 'IFERROR') {
            try { const v = scalar(run(args[0])); if (isErr(v)) return scalar(run(args[1])); return v; } catch (e) { if (e instanceof Unsupported) throw e; return scalar(run(args[1])); }
          }
          return num(run(args[0])) ? run(args[1]) : args[2] ? run(args[2]) : false;
        }
        const f = FN[t.v];
        if (!f) throw new Unsupported(`不认识的函数 ${t.v}`);
        return f(args);
      }
      throw new Unsupported(`看不懂：${t.v}`);
    };
    const percent = () => { let v = primary(); while (peek()?.v === '%') { p++; v = num(v) / 100; } return v; };
    const power = () => { let v = percent(); while (peek()?.v === '^') { p++; v = num(v) ** num(percent()); } return v; };
    const product = () => {
      let v = power();
      while (peek()?.v === '*' || peek()?.v === '/') {
        const op = toks[p++].v;
        const r = num(power());
        if (op === '/' && r === 0) throw Object.assign(new Error(ERR.div0), { excel: ERR.div0 });
        v = op === '*' ? num(v) * r : num(v) / r;
      }
      return v;
    };
    const sum = () => { let v = product(); while (peek()?.v === '+' || peek()?.v === '-') { const op = toks[p++].v; const r = num(product()); v = op === '+' ? num(v) + r : num(v) - r; } return v; };
    const concat = () => { let v = sum(); while (peek()?.v === '&') { p++; v = `${scalar(v) ?? ''}${scalar(sum()) ?? ''}`; } return v; };
    function compare() {
      let v = concat();
      while (['=', '<>', '<', '>', '<=', '>='].includes(peek()?.v)) {
        const op = toks[p++].v;
        const a = scalar(v); const b = scalar(concat());
        v = { '=': a == b, '<>': a != b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[op]; // eslint-disable-line eqeqeq
      }
      return v;
    }
    try {
      const v = scalar(compare());
      if (p < toks.length) throw new Unsupported('多余的内容');
      return typeof v === 'number' ? Math.round(v * 1e10) / 1e10 : v;
    } catch (e) {
      if (e.excel) return e.excel; // 和 Excel 一样得到 #DIV/0! 之类
      throw e;
    }
  };

  for (const s of sheets) {
    for (const [addr, c] of s.cells) {
      if (!c.formula) continue;
      try { cellValue(s, addr); } catch { results.delete(`${s.name}!${addr}`); /* 算不了：交给 Excel */ }
    }
  }
  return results;
}
