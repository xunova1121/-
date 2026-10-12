/**
 * 文档读写（全部在浏览器本地完成，不上传）：
 *   读：docx（mammoth）· pdf（pdf.js）· pptx（JSZip 解析幻灯片 XML）· xlsx / xls / csv（SheetJS）· 纯文本类
 *   写：docx（docx）· pptx（PptxGenJS）· xlsx（SheetJS）· html / md / txt；
 *       pdf：生成排版好的可打印 HTML，由用户在工作区点“导出 PDF”用浏览器打印保存
 *       （浏览器内生成带中文的 PDF 需要内嵌几 MB 的中文字体，打印方式更清晰也更小）
 * 重型库全部按需动态加载。
 */
import { parseMarkdown } from '../core/markdown.js';
import { ext, isText } from './workspace.js';

const MAX_CHARS = 60000;

// ---------------------------------------------------------------- 读取
export async function parseFile(blob, name) {
  const e = ext(name);
  const buf = () => blob.arrayBuffer();
  let text;
  if (e === 'docx') {
    const mammoth = await import('mammoth');
    const ab = await buf();
    // 浏览器版 mammoth 接收 arrayBuffer，Node 版接收 buffer（仅测试时）
    const input = typeof window === 'undefined' && typeof Buffer !== 'undefined' ? { buffer: Buffer.from(ab) } : { arrayBuffer: ab };
    text = (await (mammoth.default ?? mammoth).extractRawText(input)).value;
  } else if (e === 'pdf') {
    text = await parsePdf(await buf());
  } else if (e === 'pptx') {
    text = await parsePptx(await buf());
  } else if (['xlsx', 'xls', 'ods'].includes(e)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(new Uint8Array(await buf()), { type: 'array' });
    text = wb.SheetNames.map((n) => `## 工作表：${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
  } else if (e === 'html' || e === 'htm') {
    text = htmlToText(await blob.text());
  } else if (isText(name)) {
    text = await blob.text();
  } else {
    throw new Error(`暂不支持读取 .${e || '未知'} 格式`);
  }
  text = text.replace(/\u0000/g, '').trim();
  return { text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（内容过长，已截断，共 ${text.length} 字）` : text, chars: text.length };
}

async function parsePdf(data) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    let line = '';
    let lastY = null;
    const out = [];
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ''; }
      line += it.str;
      lastY = y;
    }
    out.push(line);
    pages.push(`--- 第 ${i} 页 ---\n${out.join('\n').trim()}`);
  }
  return pages.join('\n\n');
}

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    if (typeof window === 'undefined') return import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjs = await import('pdfjs-dist');
    // 单文件版：file:// 下模块 Worker 起不来，把内联的 Worker 源码去掉 export 后当普通 Worker 运行；正常版：独立的 worker 文件
    if (typeof __STANDALONE__ !== 'undefined' && __STANDALONE__) {
      const src = (await import('pdfjs-dist/build/pdf.worker.min.mjs?raw')).default.replace(/export\s*\{[^}]*\}\s*;?\s*$/, '');
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } else {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
    }
    return pdfjs;
  })();
  return pdfjsPromise;
}

async function parsePptx(data) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const out = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f).async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('')).filter(Boolean);
    out.push(`--- 第 ${i + 1} 页幻灯片 ---\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * 网页 → 正文文字：去掉脚本、样式、导航、页脚、侧栏、表单；页面有 <main> / <article> 时只取正文部分。
 */
export function htmlToText(html) {
  let h = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style|noscript|svg|template|iframe|nav|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, '');
  const main = [...h.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]).sort((a, b) => b.length - a.length)[0];
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) h = main;
  return h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h\d|tr|table|section|article|main|header|blockquote|pre|dd|dt|figure|figcaption)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- 生成
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const spansHtml = (spans) => spans.map((s) => (s.code ? `<code>${esc(s.text)}</code>` : s.bold ? `<strong>${esc(s.text)}</strong>` : esc(s.text))).join('');

export function markdownToHtml(md) {
  return parseMarkdown(md).map((b) => {
    if (b.type === 'heading') return `<h${b.level}>${spansHtml(b.spans)}</h${b.level}>`;
    if (b.type === 'code') return `<pre><code>${esc(b.text)}</code></pre>`;
    if (b.type === 'list') return `<${b.ordered ? 'ol' : 'ul'}>${b.items.map((i) => `<li>${spansHtml(i)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`;
    if (b.type === 'table') return `<table>${b.rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join('')}</tr>`).join('')}</table>`;
    return `<p>${spansHtml(b.spans)}</p>`;
  }).join('\n');
}

export function htmlDocument(title, md, { printable = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.75;color:#1a2230}
h1{font-size:28px;border-bottom:2px solid #1a6fb0;padding-bottom:8px}h2{font-size:21px;margin-top:28px}h3{font-size:17px}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #c9d3df;padding:6px 10px;text-align:left}th{background:#eef3f8}
code{background:#f0f3f7;padding:1px 5px;border-radius:4px}pre{background:#f0f3f7;padding:12px;border-radius:6px;overflow:auto}
${printable ? '@page{size:A4;margin:18mm}@media print{body{margin:0;max-width:none}}' : ''}
</style></head><body>
${md.trim().startsWith('#') ? '' : `<h1>${esc(title)}</h1>`}
${markdownToHtml(md)}
</body></html>`;
}

/**
 * @param {'docx'|'pptx'|'xlsx'|'html'|'md'|'txt'|'pdf'} format
 * @returns {Promise<{blob: Blob, ext: string, note?: string}>}
 */
export async function generate(format, { title = '未命名', content = '' }) {
  switch (format) {
    case 'md': case 'txt':
      return { blob: new Blob([content], { type: 'text/plain' }), ext: format };
    case 'html':
      return { blob: new Blob([htmlDocument(title, content)], { type: 'text/html' }), ext: 'html' };
    case 'pdf':
      return {
        blob: new Blob([htmlDocument(title, content, { printable: true })], { type: 'text/html' }),
        ext: 'html',
        note: '已生成 A4 排版的可打印文件。在工作区打开它，点“导出 PDF”即可另存为 PDF。'
      };
    case 'docx': return { blob: await makeDocx(title, content), ext: 'docx' };
    case 'pptx': return { blob: await makePptx(title, content), ext: 'pptx' };
    case 'xlsx': return { blob: await makeXlsx(content), ext: 'xlsx' };
    default: throw new Error(`不支持生成 ${format} 格式`);
  }
}

async function makeDocx(title, md) {
  const d = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = d;
  const runs = (spans, extra = {}) => spans.map((s) => new TextRun({ text: s.text, bold: s.bold, font: s.code ? 'Consolas' : undefined, ...extra }));
  const children = [];
  const blocks = parseMarkdown(md);
  if (!blocks.length || blocks[0].type !== 'heading') children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
  for (const b of blocks) {
    if (b.type === 'heading') children.push(new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][b.level - 1], children: runs(b.spans) }));
    else if (b.type === 'list') b.items.forEach((it, i) => children.push(new Paragraph({ children: [new TextRun(b.ordered ? `${i + 1}. ` : '• '), ...runs(it)], indent: { left: 360 } })));
    else if (b.type === 'code') for (const line of b.text.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 20 })] }));
    else if (b.type === 'table') {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 })] })] })) }))
      }));
      children.push(new Paragraph(''));
    } else children.push(new Paragraph({ children: runs(b.spans), spacing: { after: 120 } }));
  }
  const doc = new Document({ creator: '贾维斯', title, styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } } }, sections: [{ children }] });
  return Packer.toBlob(doc);
}

/** 幻灯片：每个 “# 标题” 开始一页（或用 --- 分页）；页内的列表 / 段落成为要点 */
export function splitSlides(title, md) {
  const slides = [];
  let cur = null;
  for (const line of String(md).split('\n')) {
    const h = line.match(/^#{1,2}\s+(.*)$/);
    if (h) { cur = { title: h[1].trim(), lines: [] }; slides.push(cur); continue; }
    if (/^\s*---+\s*$/.test(line)) { cur = null; continue; }
    if (!line.trim()) continue;
    if (!cur) { cur = { title: slides.length ? '' : title, lines: [] }; slides.push(cur); }
    cur.lines.push(line.replace(/^\s*(?:[-*•]|\d+[.、)])\s+/, '').replace(/\*\*/g, '').trim());
  }
  return slides;
}

async function makePptx(title, md) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  const BG = '07111F', ACCENT = '38BDF8', TEXT = 'E6F1FA', MUTED = '8AA4B8';
  const cover = pptx.addSlide();
  cover.background = { color: BG };
  cover.addShape(pptx.ShapeType.rect, { x: 0.6, y: 3.55, w: 1.2, h: 0.06, fill: { color: ACCENT } });
  cover.addText(title, { x: 0.6, y: 2.2, w: 12, h: 1.2, fontSize: 40, bold: true, color: TEXT, fontFace: 'Microsoft YaHei' });
  cover.addText(`由贾维斯生成 · ${new Date().toLocaleDateString('zh-CN')}`, { x: 0.6, y: 3.8, w: 12, h: 0.5, fontSize: 14, color: MUTED, fontFace: 'Microsoft YaHei' });
  for (const [i, s] of splitSlides(title, md).entries()) {
    const sl = pptx.addSlide();
    sl.background = { color: BG };
    sl.addText(s.title || title, { x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 28, bold: true, color: TEXT, fontFace: 'Microsoft YaHei' });
    sl.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.3, w: 0.8, h: 0.05, fill: { color: ACCENT } });
    if (s.lines.length) {
      sl.addText(s.lines.map((t) => ({ text: t, options: { bullet: { code: '25A0' }, paraSpaceAfter: 10 } })), {
        x: 0.8, y: 1.7, w: 11.6, h: 5, fontSize: 20, color: TEXT, fontFace: 'Microsoft YaHei', valign: 'top'
      });
    }
    sl.addText(String(i + 2), { x: 12.3, y: 7, w: 0.6, h: 0.3, fontSize: 10, color: MUTED, align: 'right' });
  }
  return pptx.write({ outputType: 'blob' });
}

/** 表格：内容可以是 CSV 或 Markdown 表格；用 “## 工作表名” 分成多个工作表 */
export function parseSheets(content) {
  const sheets = [];
  let cur = null;
  for (const line of String(content).split('\n')) {
    const h = line.match(/^#{1,3}\s+(?:工作表[:：]?\s*)?(.*)$/);
    if (h) { cur = { name: h[1].trim().slice(0, 31) || `Sheet${sheets.length + 1}`, rows: [] }; sheets.push(cur); continue; }
    if (!line.trim()) continue;
    if (!cur) { cur = { name: 'Sheet1', rows: [] }; sheets.push(cur); }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      cur.rows.push(cells);
    } else cur.rows.push(parseCsvLine(line));
  }
  // 数字字符串转为数字，Excel 里可以直接计算
  for (const s of sheets) s.rows = s.rows.map((r) => r.map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c)));
  return sheets;
}

function parseCsvLine(line) {
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

async function makeXlsx(content) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of parseSheets(content)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
  if (!wb.SheetNames.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
