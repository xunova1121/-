/**
 * 文档读写（全部在浏览器本地完成，不上传）：
 *   读：docx（mammoth）· pdf（pdf.js）· pptx（JSZip 解析幻灯片 XML）· xlsx / xls / csv（SheetJS）· 纯文本类
 *   写：docx（docxWriter.js）· pptx（pptxWriter.js）· xlsx（xlsxWriter.js，ExcelJS）· csv（带 BOM）· html / md / txt；Markdown 先解析成文档结构（docModel.js），
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
import { makeXlsx, makeCsv } from './xlsxWriter.js';
import { makePptx } from './pptxWriter.js';

const MAX_CHARS = 60000;

// ---------------------------------------------------------------- 读取
export async function parseFile(blob, name, options = {}) {
  options.signal?.throwIfAborted();
  let e = ext(name);
  // 后缀写 .doc 的文件很多其实是新版 Word（zip 包，PK 开头）：按内容认，不按后缀拒（用户的招标文件就是这样）
  if (e === 'doc' || e === 'wps') {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) e = 'docx';
    else if (head[0] === 0xd0 && head[1] === 0xcf && typeof options.convertLegacyDoc === 'function') {
      const converted = await options.convertLegacyDoc(blob, { signal: options.signal });
      options.signal?.throwIfAborted();
      if (!(converted instanceof Blob)) throw new Error('旧DOC转换没有返回有效文件');
      return parseFile(converted, name.replace(/\.(?:doc|wps)$/i, '.docx'), { ...options, convertLegacyDoc: null });
    }
    else throw new Error('这是老版 Word 文件（Word 97-2003 的 .doc），暂时读不了：请在 Word 或 WPS 里“另存为” .docx 后再上传');
  }
  const buf = () => blob.arrayBuffer();
  let text;
  if (e === 'docx') {
    const mammoth = await import('mammoth');
    const ab = await buf();
    // 浏览器版 mammoth 接收 arrayBuffer，Node 版接收 buffer（仅测试时）
    const input = typeof window === 'undefined' && typeof Buffer !== 'undefined' ? { buffer: Buffer.from(ab) } : { arrayBuffer: ab };
    text = (await (mammoth.default ?? mammoth).extractRawText(input)).value;
  } else if (e === 'pdf') {
    text = await parsePdf(await buf(), options);
  } else if (e === 'pptx') {
    text = await parsePptx(await buf());
  } else if (['xlsx', 'xls', 'ods'].includes(e)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(new Uint8Array(await buf()), { type: 'array', cellFormula: true, sheetStubs: true }); // sheetStubs：没存结果的公式格子也要读出来
    text = wb.SheetNames.map((n) => sheetText(XLSX, wb.Sheets[n], n)).join('\n\n');
  } else if (e === 'html' || e === 'htm') {
    text = htmlToText(await blob.text());
  } else if (isText(name)) {
    text = await blob.text();
  } else {
    throw new Error(`暂不支持读取 .${e || '未知'} 格式`);
  }
  text = text.replace(/\u0000/g, '').trim();
  // limit：最多给多少字（read_file 分段读时要全文，传 Infinity）
  const limit = options.limit ?? MAX_CHARS;
  return { text: text.length > limit ? `${text.slice(0, limit)}\n…（内容过长，已截断，共 ${text.length} 字）` : text, chars: text.length };
}

/**
 * 一个工作表 → 文字：表格内容（CSV）+ 公式清单。
 * 公式格子没有存结果时（有的软件生成的文件就是这样），CSV 里显示公式本身，不显示成空格子——
 * 不然读的人（包括未央自己）会以为公式没写进去。
 */
function sheetText(XLSX, sheet, name) {
  const formulas = [];
  for (const [addr, cell] of Object.entries(sheet)) {
    if (addr.startsWith('!') || !cell?.f) continue;
    formulas.push(`${addr} =${cell.f}`);
    if (cell.t === 'z' || cell.v === undefined || cell.v === '') { cell.t = 's'; cell.v = `=${cell.f}`; cell.w = `=${cell.f}`; }
  }
  const list = formulas.length ? `\n【公式】共 ${formulas.length} 个：${formulas.slice(0, 40).join('；')}${formulas.length > 40 ? '……' : ''}` : '';
  return `## 工作表：${name}\n${XLSX.utils.sheet_to_csv(sheet)}${list}`;
}

async function parsePdf(data, { signal, maxPages = Infinity, maxChars = Infinity } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
  if (signal?.aborted) throw signal.reason;
  const doc = await task.promise;
  let chars = 0;
  let hasText = false;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    if (signal?.aborted) throw signal.reason;
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
    hasText ||= Boolean(out.join('').trim());
    const pageText = `--- 第 ${i} 页 ---\n${out.join('\n').trim()}`;
    pages.push(pageText);
    chars += pageText.length;
    if (chars >= maxChars) break;
  }
  if (Number.isFinite(maxPages) && !hasText) throw Object.assign(new Error('PDF没有可提取正文，可能是扫描件；未执行OCR'), { code: 'PDF_NO_TEXT', kind: 'api' });
  const suffix = pages.length < doc.numPages ? `\n（PDF已截断：仅读取前${pages.length}/${doc.numPages}页，不能视为全文已读。）` : '';
  return pages.join('\n\n') + suffix;
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy().catch(() => {});
  }
}

let pdfjsPromise = null;
export function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    if (typeof window === 'undefined') return import('pdfjs-dist/legacy/build/pdf.mjs');
    // 用兼容版（legacy）：新版要求较新的浏览器内核，安卓 / 鸿蒙手机自带的 WebView 上会报“Promise.withResolvers is not a function”
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // 单文件版：file:// 下模块 Worker 起不来，把内联的 Worker 源码去掉 export 后当普通 Worker 运行；正常版：独立的 worker 文件
    if (typeof __STANDALONE__ !== 'undefined' && __STANDALONE__) {
      const src = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw')).default.replace(/export\s*\{[^}]*\}\s*;?\s*$/, '');
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } else {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
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
export async function generate(format, { title = '未命名', content = '', theme: themeName = '', cover = false, subtitle = '', author = '', date = '', toc = 'auto', loadImage = null, toPdf = null, template = null, layout = 'report', issuer = '', docNo = '', style = 'business', sheetStyle = '', kind = '', expectedSlides = null, requireCover = false, forbidCover = false, typography = {}, noRules = false, scale = 0 } = {}) {
  const theme = resolveTheme(themeName, `${title}\n${content}`);
  const page = { theme, cover, subtitle, author, date, toc, layout };
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
      const r = await makeDocx({ title, content, ...page, loadImage, template, issuer, docNo, kind, typography, noRules, scale });
      return { blob: r.blob, ext: 'docx', theme, info: r.info };
    }
    case 'pptx': {
      const r = await makePptx({ title, content, theme, subtitle, author, date, loadImage, style, expectedSlides, requireCover, forbidCover, typography });
      return { blob: r.blob, ext: 'pptx', theme, info: r.info };
    }
    case 'xlsx': {
      const r = await makeXlsx(content, { theme, kind, sheetStyle, typography });
      return { blob: r.blob, ext: 'xlsx', theme, info: r.info };
    }
    case 'csv': return { blob: makeCsv(content), ext: 'csv', theme };
    default: throw new Error(`不支持生成 ${format} 格式`);
  }
}

/** 幻灯片：每个 “# 标题” 开始一页（或用 --- 分页）；版式按内容自动选（见 pptxWriter.js） */
export { splitSlides } from './pptxWriter.js';

/** 表格：内容可以是 CSV 或 Markdown 表格；用 “## 工作表名” 分成多个工作表（见 sheetParse.js） */
export { parseSheets } from './sheetParse.js';
