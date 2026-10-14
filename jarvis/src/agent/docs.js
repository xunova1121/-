/**
 * 文档读写（全部在浏览器本地完成，不上传）：
 *   读：docx（mammoth）· pdf（pdf.js）· pptx（JSZip 解析幻灯片 XML）· xlsx / xls / csv（SheetJS）· 纯文本类
 *   写：docx（docxWriter.js）· pptx（PptxGenJS）· xlsx（SheetJS）· html / md / txt；Markdown 先解析成文档结构（docModel.js），
 *       配色字体统一用主题（themes.js）
 *       pdf：桌面版由 Electron 直接转成 PDF；网页版和安卓生成排版好的可打印 HTML，用户在工作区点“导出 PDF”
 *       （浏览器内生成带中文的 PDF 需要内嵌几 MB 的中文字体，打印方式更清晰也更小）
 * 重型库全部按需动态加载。
 */
import { ext, isText } from './workspace.js';
import { parseDoc, images } from './docModel.js';
import { htmlDocument } from './htmlWriter.js';
import { makeDocx } from './docxWriter.js';
import { resolveTheme } from './themes.js';
import { imageInfo } from './imageInfo.js';

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
export { markdownToHtml, htmlDocument } from './htmlWriter.js';

const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };

/** 文档里用到的图片 → data: 地址（网页 / PDF 用） */
async function imageMap(content, loadImage) {
  const map = new Map();
  if (!loadImage) return map;
  for (const src of images(parseDoc(content))) {
    if (map.has(src)) continue;
    try {
      const bytes = await loadImage(src);
      const info = bytes && imageInfo(bytes);
      if (info) map.set(src, `data:${MIME_OF[info.type]};base64,${toBase64(bytes)}`);
    } catch { /* 读不到就显示占位 */ }
  }
  return map;
}
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param {'docx'|'pptx'|'xlsx'|'html'|'md'|'txt'|'pdf'} format
 * @param {object} o
 * @param {string} [o.theme]  主题 id 或中文名；不填按内容自动选（themes.js）
 * @param {boolean} [o.cover]  Word / 网页 / PDF 加封面
 * @param {'auto'|boolean} [o.toc]  目录：auto = 二级标题（##）有 3 个以上时加
 * @param {(src: string) => Promise<Uint8Array|null>} [o.loadImage]  读工作区里的图片
 * @param {(html: string, o: { title: string, official: boolean }) => Promise<Uint8Array>} [o.toPdf]  桌面版：HTML 直接转 PDF
 * @param {Uint8Array|ArrayBuffer} [o.template]  Word 模板（沿用它的样式）
 * @returns {Promise<{blob: Blob, ext: string, note?: string, theme: object, info?: object}>}
 */
export async function generate(format, { title = '未命名', content = '', theme: themeName = '', cover = false, subtitle = '', author = '', date = '', toc = 'auto', loadImage = null, toPdf = null, template = null } = {}) {
  const theme = resolveTheme(themeName, `${title}\n${content}`);
  const page = { theme, cover, subtitle, author, date, toc };
  switch (format) {
    case 'md': case 'txt':
      return { blob: new Blob([content], { type: 'text/plain' }), ext: format, theme };
    case 'html':
      return { blob: new Blob([htmlDocument(title, content, { ...page, images: await imageMap(content, loadImage) })], { type: 'text/html' }), ext: 'html', theme };
    case 'pdf': {
      const html = htmlDocument(title, content, { ...page, printable: true, images: await imageMap(content, loadImage) });
      if (toPdf) {
        const bytes = await toPdf(html, { title, official: Boolean(theme.official) });
        return { blob: new Blob([bytes], { type: 'application/pdf' }), ext: 'pdf', theme };
      }
      return {
        blob: new Blob([html], { type: 'text/html' }),
        ext: 'html',
        theme,
        note: '已生成 A4 排版的可打印文件。在工作区打开它，点“导出 PDF”即可另存为 PDF。'
      };
    }
    case 'docx': {
      const r = await makeDocx({ title, content, ...page, loadImage, template });
      return { blob: r.blob, ext: 'docx', theme, info: r.info };
    }
    case 'pptx': return { blob: await makePptx(title, content), ext: 'pptx', theme };
    case 'xlsx': return { blob: await makeXlsx(content), ext: 'xlsx', theme };
    default: throw new Error(`不支持生成 ${format} 格式`);
  }
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
