import { openOfficePackage, orderedSlidePaths } from './officePackage.js';
import { parseXml, serialize, digest, packageBlob, descendants, attr } from './documentXml.js';
import { wordObjects, editWord } from './wordStructuredEdit.js';
import { slideObjects, editSlide } from './slideStructuredEdit.js';
import { workbookSheets, editSheet } from './sheetStructuredEdit.js';
import { documentError } from './documentPlan.js';

export const EDIT_CAPABILITIES = {
  docx: [
    'format:target=id/role/text; font_size/font_family/bold/underline/alignment/space_before/space_after/line_spacing/keep_next/page_break_before/remove_lines',
    'table_layout:target=table id; repeat_header/keep_rows/keep_table',
    'page_layout:毫米top/bottom/left/right（所有分节）',
    'update_toc:真实Office更新目录及页码'
  ],
  pptx: ['format:target=id或page及可选text; font_size/font_family/bold/color/alignment', 'move_resize:target=id; x/y/width/height英寸'],
  xlsx: [
    'format:target=sheet+range; font_size/font_family/bold/color/alignment/wrap_text/number_format',
    'page_layout:target=sheet; orientation/fit_width/fit_height'
  ],
  pdf: [
    'rotate_pages:target.pages; properties.angle=90/180/270',
    'reorder_pages:properties.order为全部页码的排列，不删除页',
    'crop_pages:target.pages; properties.x/y/width/height单位PDF点；仅改变可视区域，不是涂黑或删除原文'
  ]
};
export async function inspectEditableDocument(blob, kind, { offset = 0, limit = 60, signal } = {}) {
  signal?.throwIfAborted();
  const sha256 = await digest(blob);
  if (!EDIT_CAPABILITIES[kind]) throw documentError('支持docx/pptx/xlsx/pdf结构编辑');
  let objects = [];
  if (kind === 'pdf') {
    const { PDFDocument } = await import('pdf-lib');
    if (blob.size > 20e6) throw documentError('PDF超过20MB');
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    if (pdf.getPageCount() > 120) throw documentError('PDF最多120页');
    objects = pdf.getPages().map((p, i) => ({ id: `page${i + 1}`, page: i + 1, width: p.getWidth(), height: p.getHeight(), rotation: p.getRotation().angle }));
  } else {
    const zip = await openOfficePackage(blob);
    const read = async (p) => parseXml((await zip.file(p)?.async('string')) || '<empty/>');
    if (kind === 'docx') {
      const { paragraphs, tables } = wordObjects(await read('word/document.xml'), await read('word/styles.xml'));
      objects = [...paragraphs, ...tables].map(({ node, ...o }) => ({ ...o, text: o.text.slice(0, 240), truncated: o.text.length > 240 }));
    } else if (kind === 'pptx') {
      const paths = await orderedSlidePaths(zip);
      for (const [i, p] of paths.entries())
        objects.push(...slideObjects(await read(p), i + 1).map(({ node, ...o }) => ({ ...o, text: o.text.slice(0, 240), truncated: o.text.length > 240 })));
    } else {
      const sheets = workbookSheets(await read('xl/workbook.xml'), await read('xl/_rels/workbook.xml.rels'));
      for (const s of sheets) {
        const doc = await read(s.path);
        objects.push({
          sheet: s.name,
          range: attr(descendants(doc, 'x', 'dimension')[0], 'ref'),
          cells: descendants(doc, 'x', 'c').length,
          note: '内容用read_file读取；格式操作按sheet/range定位，保留数值与公式'
        });
      }
    }
  }
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw documentError('结构读取分页无效');
  return {
    format: kind,
    sha256,
    total: objects.length,
    offset,
    next: offset + limit < objects.length ? offset + limit : null,
    objects: objects.slice(offset, offset + limit),
    capabilities: EDIT_CAPABILITIES[kind],
    limits: '不保证任意复杂版式或扫描PDF正文编辑；不支持的操作明确失败。排版结果须真实渲染后核对。'
  };
}
export async function applyStructuredEdits(blob, kind, operations, { expectedDigest, signal } = {}) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || '') || (await digest(blob)) !== expectedDigest)
    throw documentError('文件已变化或缺少结构读取的sha256，请重读后再修改', 'DOCUMENT_CONFLICT');
  if (!Array.isArray(operations) || !operations.length || operations.length > 30) throw documentError('每批须1至30项操作');
  const supported = {
    docx: ['format', 'table_layout', 'page_layout', 'update_toc'],
    pptx: ['format', 'move_resize'],
    xlsx: ['format', 'page_layout'],
    pdf: ['rotate_pages', 'reorder_pages', 'crop_pages']
  };
  for (const op of operations) {
    if (!supported[kind]?.includes(op?.action)) throw documentError('该格式暂不支持此操作，不会用重建或遮盖冒充编辑', 'DOCUMENT_UNSUPPORTED');
    if (!op || typeof op.action !== 'string' || (op.action !== 'update_toc' && (!op.properties || !Object.keys(op.properties).length)))
      throw documentError('操作和具体修改属性不能为空');
    if (op.target && ['id', 'role', 'text'].filter((k) => op.target[k] !== undefined).length > 1) throw documentError('目标id、role、text只能选一个，避免歧义');
  }
  if (kind === 'pdf') return editPdf(blob, operations, signal);
  const zip = await openOfficePackage(blob),
    docs = new Map();
  const read = async (p) => {
    if (!docs.has(p)) {
      const raw = await zip.file(p)?.async('string');
      if (!raw) throw documentError('缺少文件部件：' + p);
      docs.set(p, parseXml(raw));
    }
    return docs.get(p);
  };
  let changes = [],
    updateToc = false;
  if (kind === 'docx') {
    const result = editWord(await read('word/document.xml'), await read('word/styles.xml'), operations);
    changes = result.changes;
    updateToc = result.updateToc;
  } else if (kind === 'pptx') {
    const paths = await orderedSlidePaths(zip);
    for (const op of operations) {
      let matched = 0;
      for (const [i, p] of paths.entries()) {
        signal?.throwIfAborted();
        matched += editSlide(await read(p), i + 1, op);
      }
      if (!matched) throw documentError('PPT目标未命中', 'DOCUMENT_SCOPE');
      changes.push({ action: op.action, matched });
    }
    // 排版修改后旧生成底稿已失效，不允许之后以旧底稿覆盖用户修改。
  } else if (kind === 'xlsx') {
    const sheets = workbookSheets(await read('xl/workbook.xml'), await read('xl/_rels/workbook.xml.rels'));
    const styles = await read('xl/styles.xml');
    for (const op of operations) {
      const sheet = sheets.find((s) => s.name === op.target?.sheet);
      if (!sheet) throw documentError('工作表未命中', 'DOCUMENT_SCOPE');
      const matched = editSheet(await read(sheet.path), styles, op);
      if (!matched) throw documentError('范围没有已有单元格', 'DOCUMENT_SCOPE');
      changes.push({ action: op.action, matched });
    }
  } else throw documentError('不支持的格式');
  for (const [p, doc] of docs) {
    signal?.throwIfAborted();
    const xml = serialize(doc);
    const original = await zip.file(p).async('string');
    if (xml !== original) zip.file(p, xml);
  }
  return {
    blob: await packageBlob(zip, blob.type),
    changes,
    updateToc,
    preservation: { state: 'passed', scope: '仅修改选中XML格式属性；文字/公式/数据不改，未触及的图片与关系部件保留。不是视觉验收' }
  };
}
async function editPdf(blob, operations, signal) {
  if (blob.size > 20e6) throw documentError('PDF超过20MB');
  const { PDFDocument, degrees } = await import('pdf-lib');
  const pdf = await PDFDocument.load(await blob.arrayBuffer());
  const count = pdf.getPageCount();
  if (count > 120) throw documentError('PDF最多120页');
  const changes = [];
  for (const op of operations) {
    signal?.throwIfAborted();
    const props = op.properties || {};
    if (op.action === 'reorder_pages') {
      const order = props.order;
      if (!Array.isArray(order) || order.length !== count || new Set(order).size !== count || order.some((n) => !Number.isInteger(n) || n < 1 || n > count))
        throw documentError('页序必须包含全部原页且不重复；本操作不删除内容');
      const pages = pdf.getPages();
      for (let i = count - 1; i >= 0; i--) pdf.removePage(i);
      for (const n of order) pdf.addPage(pages[n - 1]);
      changes.push({ action: op.action, matched: count });
      continue;
    }
    const pages = op.target?.pages;
    if (!Array.isArray(pages) || !pages.length || pages.some((n) => !Number.isInteger(n) || n < 1 || n > count) || new Set(pages).size !== pages.length)
      throw documentError('PDF页码无效');
    for (const n of pages) {
      const page = pdf.getPage(n - 1);
      if (op.action === 'rotate_pages') {
        if (![90, 180, 270].includes(props.angle)) throw documentError('旋转角度须90/180/270');
        page.setRotation(degrees((page.getRotation().angle + props.angle) % 360));
      } else if (op.action === 'crop_pages') {
        const { x, y, width, height } = props,
          m = page.getMediaBox();
        if (
          [x, y, width, height].some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
          width <= 0 ||
          height <= 0 ||
          x < m.x ||
          y < m.y ||
          x + width > m.x + m.width ||
          y + height > m.y + m.height
        )
          throw documentError('裁切区域越界');
        page.setCropBox(x, y, width, height);
      } else throw documentError('PDF暂不支持该操作；不能用遮盖冒充正文编辑', 'DOCUMENT_UNSUPPORTED');
    }
    changes.push({ action: op.action, matched: pages.length });
  }
  signal?.throwIfAborted();
  return {
    blob: new Blob([await pdf.save()], { type: 'application/pdf' }),
    changes,
    preservation: { state: 'passed', scope: '保留全部页面，只调整页序/旋转/可视裁切；裁切不删除底层信息，不适用于脱敏' }
  };
}
