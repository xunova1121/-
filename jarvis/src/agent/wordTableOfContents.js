import { openOfficePackage, xmlEscape } from './officePackage.js';
import { parseXml, serialize, descendants, children, attr, ancestor, packageBlob, wordText, NS } from './documentXml.js';
import { loadPdfjs } from './docs.js';
import { documentError } from './documentPlan.js';
import { wordObjects, hasToc } from './wordStructuredEdit.js';

const fault = (text) => documentError(text, 'DOCUMENT_TOC');
function tocRange(doc) {
  const instructions = descendants(doc, 'w', 'instrText').filter((n) => /\bTOC\b/.test(n.textContent));
  const simple = descendants(doc, 'w', 'fldSimple').filter((n) => /\bTOC\b/.test(attr(n, 'instr', 'w') || ''));
  if (instructions.length + simple.length !== 1) throw fault('只支持一份明确的正文目录；多个目录须分别定位');
  const field = instructions[0] || simple[0],
    body = descendants(doc, 'w', 'body')[0];
  const sdt = ancestor(field, 'sdt');
  if (sdt?.parentNode === body) {
    assertTocRegion([sdt]);
    return [sdt];
  }
  const start = ancestor(field, 'p');
  if (start?.parentNode !== body) throw fault('目录位于嵌套容器，不能安全替换');
  if (simple.length) {
    assertTocRegion([start]);
    return [start];
  }
  const nodes = [];
  let depth = 0,
    opened = false;
  for (let n = start; n; n = n.nextSibling) {
    nodes.push(n);
    if (n.nodeType !== 1) continue;
    for (const f of descendants(n, 'w', 'fldChar')) {
      const type = attr(f, 'fldCharType', 'w');
      if (type === 'begin') {
        depth++;
        opened = true;
      }
      if (type === 'end') depth--;
    }
    if (opened && depth === 0) {
      assertTocRegion(nodes);
      return nodes;
    }
    if (nodes.length > 1000 || n.localName === 'sectPr') break;
  }
  throw fault('目录域起止不完整，保留原件');
}
function assertTocRegion(nodes) {
  let depth = 0;
  const outside = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.localName === 'sectPr' || node.localName === 'tbl' || node.localName === 'drawing') throw fault('目录范围包含分节、表格或图片，不能安全替换');
    if (node.localName === 'fldSimple' && /\bTOC\b/.test(attr(node, 'instr', 'w') || '')) return;
    if (node.localName === 'fldChar') {
      const kind = attr(node, 'fldCharType', 'w');
      if (kind === 'begin') depth++;
      if (kind === 'end') depth--;
    }
    if (node.localName === 't' && depth === 0 && node.textContent.trim()) outside.push(node.textContent);
    for (const child of children(node)) visit(child);
  };
  nodes.forEach(visit);
  if (depth !== 0 || outside.some((t) => !/^(目录|contents|table of contents)$/i.test(t.trim()))) throw fault('目录域外还有正文，不能整段替换');
}
function headings(doc, styles, minLevel = 1, maxLevel = 3) {
  const result = wordObjects(doc, styles).paragraphs.filter((p) => p.role === 'heading' && p.level >= minLevel && p.level <= maxLevel);
  if (!result.length || result.length > 200) throw fault('目录须有1至200条可核对标题');
  const body = descendants(doc, 'w', 'body')[0];
  let group = [],
    section = 0;
  const groups = [];
  for (const block of children(body)) {
    group.push(block);
    const sect = block.localName === 'sectPr' ? block : descendants(block, 'w', 'sectPr')[0];
    if (sect) {
      groups.push({ nodes: group, sect, section: section++ });
      group = [];
    }
  }
  if (group.length) groups.push({ nodes: group, section });
  for (const g of groups) {
    const num = g.sect && children(g.sect, 'pgNumType')[0];
    const start = num && attr(num, 'start', 'w'),
      format = num && attr(num, 'fmt', 'w');
    if (format && format !== 'decimal') throw fault('非阿拉伯页码暂不能自动核对，保留原目录');
    const hs = result.filter((h) => g.nodes.some((n) => n === h.node || descendants(n, 'w', 'p').includes(h.node)));
    if (start && g.section > 0) {
      const first = g.nodes.find((n) => wordText(n).trim());
      if (!hs.length || first !== hs[0].node) throw fault('重启页码的分节起点不是可定位标题，不能猜测目录页码');
    }
    for (const h of hs) {
      h.section = g.section;
      h.restart = start ? Number(start) : null;
      h.sectionFirst = hs[0] === h;
    }
  }
  return result;
}
async function pagesFromPdf(blob, expected, signal) {
  const lib = await loadPdfjs(),
    task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  const abort = () => {
    void task.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await task.promise;
    if (pdf.numPages > 120) throw fault('目录更新最多120页');
    const flat = [];
    const walk = (rows) => {
      for (const row of rows || []) {
        flat.push(row);
        walk(row.items);
      }
    };
    walk(await pdf.getOutline());
    const labels = await pdf.getPageLabels();
    let from = 0;
    const pages = [];
    for (const h of expected) {
      const index = flat.findIndex((r, i) => i >= from && r.title.replace(/\s/g, '') === h.text.replace(/\s/g, ''));
      if (index < 0) throw fault('真实PDF未找到标题定位：' + h.text.slice(0, 60));
      const row = flat[index];
      from = index + 1;
      let dest = row.dest;
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) throw fault('PDF标题没有有效页码定位');
      const page = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      if (!Number.isInteger(page) || page < 0 || page >= pdf.numPages) throw fault('PDF标题页码无效');
      pages.push({ text: h.text, level: h.level, page: page + 1, label: labels?.[page] || String(page + 1) });
    }
    let shift = 0;
    for (let i = 0; i < pages.length; i++) {
      const h = expected[i];
      if (h.sectionFirst && h.restart !== null) shift = h.section === 0 ? h.restart - 1 : h.restart - pages[i].page;
      pages[i].label = String(pages[i].page + shift);
    }
    return { pages, total: pdf.numPages };
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
    signal?.throwIfAborted();
  }
}
function fillToc(doc, rows, instruction) {
  const range = tocRange(doc),
    before = range.map(wordText).join('');
  const body = range[0].parentNode;
  const section = descendants(doc, 'w', 'sectPr')[0],
    size = section && children(section, 'pgSz')[0],
    margin = section && children(section, 'pgMar')[0];
  const tabWidth = Math.max(
    1000,
    Number(attr(size, 'w', 'w') || 11906) - Number(attr(margin, 'left', 'w') || 1440) - Number(attr(margin, 'right', 'w') || 1440)
  );
  const oldParagraphs = range.flatMap((n) => (n.localName === 'p' ? [n] : descendants(n, 'w', 'p')));
  const props = (row) => {
    const old = oldParagraphs.find((p) => wordText(p).replace(/\s/g, '').startsWith(row.text.replace(/\s/g, '')));
    const pp = old && children(old, 'pPr')[0];
    const rp = old && descendants(old, 'w', 'rPr')[0];
    return {
      p: pp
        ? serialize(pp)
        : `<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${tabWidth}"/></w:tabs><w:ind w:left="${Math.max(0, (row.level || 1) - 1) * 240}"/><w:spacing w:after="100"/><w:keepLines/></w:pPr>`,
      r: rp ? serialize(rp) : ''
    };
  };
  let previous = range[0].previousSibling;
  while (previous && !wordText(previous.nodeType === 1 ? previous : doc.createElementNS(NS.w, 'w:p')).trim()) previous = previous.previousSibling;
  const externalTitle = previous?.nodeType === 1 && /^(目录|contents|tableofcontents)$/i.test(wordText(previous).replace(/\s/g, ''));
  const oldTitle = oldParagraphs.find((p) => /^(目录|contents|tableofcontents)$/i.test(wordText(p).replace(/\s/g, '')));
  const titleXml = externalTitle ? '' : oldTitle ? serialize(oldTitle) : '<w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>目录</w:t></w:r></w:p>';
  const paragraphs = rows
    .map(
      (r, i) =>
        `<w:p>${props(r).p}${i === 0 ? `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${xmlEscape(instruction)}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>` : ''}<w:r>${props(r).r}<w:t>${xmlEscape(r.text)}</w:t></w:r><w:r><w:tab/></w:r><w:r>${props(r).r}<w:t>${xmlEscape(r.label)}</w:t></w:r>${i === rows.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : ''}</w:p>`
    )
    .join('');
  const node = parseXml(
    `<w:sdt xmlns:w="${NS.w}"><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${titleXml}${paragraphs}</w:sdtContent></w:sdt>`
  ).documentElement;
  body.insertBefore(doc.importNode(node, true), range[0]);
  for (const n of range) body.removeChild(n);
  return before;
}
/** 最多四轮实际分页求稳定解；只写目录缓存，不重写正文/图片/关系。 */
export async function refreshWordToc(ctx, blob, { signal, progress } = {}) {
  const zip = await openOfficePackage(blob),
    doc = parseXml(await zip.file('word/document.xml').async('string'));
  if (!hasToc(doc)) return { blob, state: 'not_present' };
  if (!ctx.officeRender) throw fault('本端没有Office真实分页能力，不能确认目录页码；请在服务器模式处理');
  const styles = parseXml(await zip.file('word/styles.xml').async('string'));
  const instruction =
    descendants(doc, 'w', 'instrText')
      .map((n) => n.textContent)
      .find((t) => /\bTOC\b/.test(t)) ||
    attr(
      descendants(doc, 'w', 'fldSimple').find((n) => /\bTOC\b/.test(attr(n, 'instr', 'w') || '')),
      'instr',
      'w'
    ) ||
    '';
  if (/\\[tfnabcp]/i.test(instruction)) throw fault('该目录包含自定义域规则，当前不改写其语义');
  const levels = /\\o\s+"([1-9])-([1-9])"/.exec(instruction);
  const minLevel = levels ? Number(levels[1]) : 1,
    maxLevel = levels ? Number(levels[2]) : 3;
  if (minLevel > maxLevel) throw fault('目录标题级别范围无效');
  const expected = headings(doc, styles, minLevel, maxLevel);
  tocRange(doc);
  let candidate = blob,
    previous = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    signal?.throwIfAborted();
    progress?.(`更新目录实际页码（${attempt}/4）…`);
    const rendered = await ctx.officeRender(candidate, 'docx', { signal });
    if (!rendered.available || !rendered.blob) throw fault(rendered.reason || 'Office未生成分页结果');
    const current = await pagesFromPdf(rendered.blob, expected, signal);
    const key = JSON.stringify(current);
    if (key === previous)
      return { blob: candidate, state: 'updated_verified', pages: current.total, entries: current.pages.length, passes: attempt, preview: rendered };
    previous = key;
    const existingRange = tocRange(doc),
      outside = children(descendants(doc, 'w', 'body')[0])
        .filter((n) => !existingRange.includes(n))
        .map(serialize)
        .join('');
    fillToc(doc, current.pages, instruction);
    const nextRange = tocRange(doc),
      after = children(descendants(doc, 'w', 'body')[0])
        .filter((n) => !nextRange.includes(n))
        .map(serialize)
        .join('');
    if (outside !== after) throw fault('目录更新触及正文，未保存');
    zip.file('word/document.xml', serialize(doc));
    candidate = await packageBlob(zip, blob.type);
  }
  throw fault('四轮实际分页后目录仍未稳定；保留原件，不提交不确定页码');
}
