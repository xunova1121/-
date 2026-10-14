/**
 * 改已有的 Word / PPT，保留原来的格式：用 JSZip（MIT）解开文件，只改文字节点，其他（样式、图片、表格、版式）原样保留。
 *
 *   替换文字  Word 经常把一句话拆成好几段带格式的文字（run）。按段落把文字拼起来找，
 *            找到后新文字放进匹配开头所在的那一段（沿用它的字体、颜色、加粗），后面被覆盖的部分删掉。
 *            范围：Word 的正文、页眉、页脚、脚注；PPT 的每一页和备注。
 *   追加段落  只支持 Word：在正文末尾追加，格式照抄最后一个有文字的正文段落。
 */

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => XML_ESC[c]);
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/**
 * 在一段 XML（一个段落）里替换文字，跨 run 也能找到
 * @param {string} para  段落 XML
 * @param {string} tag  'w:t'（Word）或 'a:t'（PPT）
 * @returns {{ xml: string, count: number }}
 */
export function replaceInParagraph(para, tag, find, replace) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([^<]*)</${tag}>|<${tag}(\\s[^>]*)?/>`, 'g');
  const segs = [];
  let m;
  while ((m = re.exec(para))) segs.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] ?? m[3] ?? '', text: unesc(m[2] ?? '') });
  if (!segs.length) return { xml: para, count: 0 };
  const full = segs.map((s) => s.text).join('');
  if (!full.includes(find)) return { xml: para, count: 0 };
  // 每段文字在拼接后的位置
  let pos = 0;
  for (const s of segs) { s.from = pos; pos += s.text.length; s.to = pos; }
  const texts = segs.map((s) => s.text);
  let count = 0;
  // 从后往前替换，前面的位置不受影响
  const hits = [];
  for (let i = full.indexOf(find); i >= 0; i = full.indexOf(find, i + find.length)) hits.push(i);
  for (const at of hits.reverse()) {
    const endAt = at + find.length;
    const first = segs.findIndex((s) => at >= s.from && at < s.to);
    if (first < 0) continue;
    for (let k = first; k < segs.length && segs[k].from < endAt; k++) {
      const s = segs[k];
      const a = Math.max(at, s.from) - s.from;
      const b = Math.min(endAt, s.to) - s.from;
      texts[k] = texts[k].slice(0, a) + (k === first ? replace : '') + texts[k].slice(b);
    }
    count++;
  }
  // 拼回 XML
  let out = '';
  let last = 0;
  for (const [k, s] of segs.entries()) {
    out += para.slice(last, s.start);
    const attrs = /xml:space=/.test(s.attrs) ? s.attrs : `${s.attrs} xml:space="preserve"`;
    out += tag === 'a:t' ? `<${tag}${s.attrs}>${esc(texts[k])}</${tag}>` : `<${tag}${attrs}>${esc(texts[k])}</${tag}>`;
    last = s.end;
  }
  out += para.slice(last);
  return { xml: out, count };
}

/** 文件里每个段落替换 */
function replaceInXml(xml, pTag, tTag, find, replace) {
  let count = 0;
  const re = new RegExp(`<${pTag}(?=[\\s>])[\\s\\S]*?</${pTag}>`, 'g');
  const out = xml.replace(re, (p) => {
    const r = replaceInParagraph(p, tTag, find, replace);
    count += r.count;
    return r.xml;
  });
  return { xml: out, count };
}

/** Word：在正文末尾追加段落，格式照抄最后一个有文字的段落 */
function appendParagraphs(doc, paragraphs) {
  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!body) throw new Error('这不是有效的 Word 文档（找不到正文）');
  const paras = [...body[1].matchAll(/<w:p(?=[\s>])[\s\S]*?<\/w:p>/g)].map((m) => m[0]).filter((p) => /<w:t[\s>][^<]*\S/.test(p));
  const model = paras.at(-1) ?? '';
  const pPr = model.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0]?.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, '').replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '') ?? '';
  const rPr = model.match(/<w:r(?=[\s>])[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1] ?? '';
  const xml = paragraphs.map((t) => `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join('');
  // 放在最后的 sectPr（页面设置）之前
  const i = doc.lastIndexOf('<w:sectPr');
  const j = doc.lastIndexOf('</w:body>');
  const at = i > doc.lastIndexOf('</w:p>') && i < j ? i : j;
  return doc.slice(0, at) + xml + doc.slice(at);
}

/**
 * @param {Uint8Array|ArrayBuffer|Blob} input
 * @param {'docx'|'pptx'} kind
 * @param {{ replacements?: Array<{ find: string, replace: string }>, append?: string[] }} o
 * @returns {Promise<{ blob: Blob, replaced: Array<{ find: string, count: number }>, appended: number }>}
 */
export async function editOffice(input, kind, { replacements = [], append = [] }) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(input instanceof Blob ? await input.arrayBuffer() : input);
  const files = Object.keys(zip.files).filter((f) => (kind === 'docx'
    ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f)
    : /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(f)));
  if (!files.length) throw new Error(kind === 'docx' ? '这不是有效的 Word 文档' : '这不是有效的 PPT 文件');
  const [pTag, tTag] = kind === 'docx' ? ['w:p', 'w:t'] : ['a:p', 'a:t'];
  const xmls = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await zip.file(f).async('string')])));
  const replaced = [];
  for (const { find, replace } of replacements) {
    if (!find) continue;
    let count = 0;
    for (const f of files) {
      const r = replaceInXml(xmls[f], pTag, tTag, String(find), String(replace ?? ''));
      xmls[f] = r.xml;
      count += r.count;
    }
    replaced.push({ find, count });
  }
  let appended = 0;
  if (append.length) {
    if (kind !== 'docx') throw new Error('追加段落目前只支持 Word；PPT 请用替换文字，或重新生成');
    xmls['word/document.xml'] = appendParagraphs(xmls['word/document.xml'], append.map(String));
    appended = append.length;
  }
  for (const f of files) zip.file(f, xmls[f]);
  const type = kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const blob = new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], { type });
  return { blob, replaced, appended };
}
