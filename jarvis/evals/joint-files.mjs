/**
 * 30 题联合复测：把服务器上生成的文件真的下载回来量一遍（字号、横线、下划线、页数、表头加粗），
 * 和题目要求、回答里说的对照。量不出的照实记 null，不当成“做到了”。
 */
import JSZip from 'jszip';
import { measureDocx } from '../src/agent/styleCheck.js';

const OFFICE = /\.(docx|pptx|xlsx)$/i;

/** 下载工作区文件（只读接口；令牌只放在请求头里） */
export function fileDownloader(base, token, fetchImpl = fetch) {
  const url = new URL(base);
  return async (path, { maxBytes = 20e6 } = {}) => {
    const response = await fetchImpl(new URL(url.pathname.replace(/\/$/, '') + '/api/files/raw?path=' + encodeURIComponent(path), url.origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? null : bytes;
  };
}

/** Excel 第一行有内容的单元格是否全加粗（表头） */
export async function xlsxHeaderBold(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const styles = (await zip.file('xl/styles.xml')?.async('string')) || '';
    const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) || '';
    const fonts = [...(styles.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1] || '').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)].map((m) => /<b\b(?![^>]*val="(?:0|false)")/.test(m[1]));
    const xfs = [...(styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '').matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => Number(m[0].match(/fontId="(\d+)"/)?.[1]) || 0);
    const row = sheet.match(/<row\b[^>]*>([\s\S]*?)<\/row>/)?.[1] || '';
    const cells = [...row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].filter((m) => /<v>|<t[ >]/.test(m[2]));
    if (!cells.length) return null;
    return cells.every((m) => fonts[xfs[Number(m[1].match(/\bs="(\d+)"/)?.[1]) || 0]] === true);
  } catch {
    return null;
  }
}

/** 一轮回答交付的 Office 文件（最后一个）量出来的事实 */
export async function turnFileFacts(turn, download) {
  const path = [...(turn.files || [])].reverse().find((p) => OFFICE.test(p) && !/文档检查\//.test(p));
  if (!path) return null;
  const bytes = await download(path).catch(() => null);
  if (!bytes) return { path, readable: false };
  const facts = await measureDocx(new Blob([bytes]));
  const format = path.match(OFFICE)[1].toLowerCase();
  // 页数：生成时的检查报告（文档检查/<文件名>-<格式>.json）里有真实 PDF 页数
  const slash = path.lastIndexOf('/');
  const report = await download(`${path.slice(0, slash + 1)}文档检查/${path.slice(slash + 1).replace(/\.[^.]+$/, '')}-${format}.json`, { maxBytes: 2e6 }).catch(() => null);
  let pages = null;
  try { pages = report ? JSON.parse(new TextDecoder().decode(report)).pages ?? null : null; } catch { pages = null; }
  return { path, readable: true, format, body: facts?.body ?? null, title: facts?.title ?? null, rules: facts?.rules ?? null, underlines: facts?.underlines ?? null, pages, ...(format === 'xlsx' && { headerBold: await xlsxHeaderBold(bytes) }) };
}

/**
 * 按题目的 file 要求判断，返回不满足的项（空数组 = 都满足；量不出的写“没法确认”也算不满足，不能判通过）
 * @param {{ format: string, first?: object, after?: 'bigger'|'smaller', afterRules?: number, body?: number, title?: number }} want
 */
export function fileProblems(want, facts) {
  if (!want) return [];
  const [first, last] = [facts[0], facts.at(-1)];
  const problems = [];
  if (!first?.readable) return ['没有可下载的' + want.format + '文件'];
  const unknown = (v) => v === null || v === undefined;
  if (want.first?.minBody && (unknown(first.body) || first.body < want.first.minBody)) problems.push(`第一版正文${first.body ?? '量不出'}磅，要求至少${want.first.minBody}磅`);
  if (want.first && 'maxRules' in want.first && (unknown(first.rules) || first.rules > want.first.maxRules)) problems.push(`第一版横线${first.rules ?? '量不出'}条`);
  if (want.first?.minBody && first.pages !== null && first.pages !== 1) problems.push(`第一版${first.pages}页，要求1页`);
  if (want.body && (unknown(last.body) || last.body !== want.body)) problems.push(`正文${last.body ?? '量不出'}磅，要求${want.body}磅`);
  if (want.title && (unknown(last.title) || last.title !== want.title)) problems.push(`表头/标题${last.title ?? '量不出'}磅，要求${want.title}磅`);
  if (want.format === 'xlsx' && want.title && last.headerBold !== true) problems.push('表头没有全部加粗（或量不出）');
  if (want.after) {
    if (facts.length < 2 || !last?.readable) problems.push('追问后没有新文件可比');
    else if (unknown(first.body) || unknown(last.body) || (want.after === 'bigger' ? last.body <= first.body : last.body >= first.body))
      problems.push(`追问要${want.after === 'bigger' ? '变大' : '变小'}，正文从${first.body ?? '?'}磅到${last.body ?? '?'}磅`);
  }
  if ('afterRules' in want && (unknown(last?.rules) || last.rules > want.afterRules)) problems.push(`追问后横线${last?.rules ?? '量不出'}条`);
  return problems;
}

const DELIVERABLE = /\.(docx|pptx|xlsx|png|svg|pdf|md|html)$/i;
const unescape = (t) => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Excel 内容摘要：行数、公式个数、前 6 行的文字（给评审员核对“三行数据”“公式真的存在”） */
export async function xlsxContent(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const shared = [...((await zip.file('xl/sharedStrings.xml')?.async('string')) || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
    const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) || '';
    const rows = [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => [...r[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((c) => {
      const v = c[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      const formula = c[2].match(/<f>([\s\S]*?)<\/f>/)?.[1];
      return (/t="s"/.test(c[1]) ? shared[Number(v)] ?? '' : unescape(v)) + (formula ? `（=${unescape(formula)}）` : '');
    }).filter(Boolean));
    return { rows: rows.length, formulas: (sheet.match(/<f>/g) || []).length, preview: rows.slice(0, 6).map((r) => r.join(' | ').slice(0, 160)) };
  } catch {
    return null;
  }
}
/** PPT 页数和每页标题文字（前 80 字） */
export async function pptxContent(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
    const text = [];
    for (const n of slides.slice(0, 12)) text.push(unescape([...(await zip.file(n).async('string')).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(' ')).slice(0, 80));
    return { slides: slides.length, text };
  } catch {
    return null;
  }
}
/** Word 正文前 600 字 */
export async function docxContent(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const xml = (await zip.file('word/document.xml')?.async('string')) || '';
    return { text: unescape([...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join('')).filter(Boolean).join('\n')).slice(0, 600) };
  } catch {
    return null;
  }
}

/**
 * 给评审员的证据：这一轮交付的每个文件（最多 4 个）——能不能下载、Office 字号 / 内容 / 生成时的检查报告（页数、错误、问题）。
 * 只读文件，不改；读不了照实写 readable:false。
 */
export async function turnEvidence(turn, download) {
  const files = [...new Set((turn.files || []).filter((p) => DELIVERABLE.test(p) && !/文档检查\//.test(p)))].slice(-4);
  const out = [];
  for (const path of files) {
    const format = path.match(DELIVERABLE)[1].toLowerCase();
    const bytes = await download(path).catch(() => null);
    if (!bytes) { out.push({ path, format, readable: false }); continue; }
    const row = { path, format, readable: true, bytes: bytes.byteLength };
    if (OFFICE.test(path)) {
      const facts = await measureDocx(new Blob([bytes]));
      Object.assign(row, facts ? { body: facts.body, title: facts.title, rules: facts.rules, underlines: facts.underlines } : {});
      Object.assign(row, format === 'xlsx' ? await xlsxContent(bytes) || {} : format === 'pptx' ? await pptxContent(bytes) || {} : await docxContent(bytes) || {});
      const slash = path.lastIndexOf('/');
      const report = await download(`${path.slice(0, slash + 1)}文档检查/${path.slice(slash + 1).replace(/\.[^.]+$/, '')}-${format}.json`, { maxBytes: 2e6 }).catch(() => null);
      try {
        const r = report ? JSON.parse(new TextDecoder().decode(report)) : null;
        if (r) row.check = { pages: r.pages ?? null, slides: r.slides ?? null, render: r.render ?? null, pdfCheck: r.pdfCheck ?? null, errors: r.errors ?? null, issues: (r.issues || []).slice(0, 6).map((i) => `${i.level}:${String(i.text).slice(0, 100)}`) };
      } catch { /* 检查报告读不了就不带 */ }
    }
    out.push(row);
  }
  return out;
}
