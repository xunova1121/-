import * as ws from './workspace.js';
import { inspectEditableDocument, applyStructuredEdits } from './structuredDocumentEdit.js';
import { refreshWordToc } from './wordTableOfContents.js';
import { deliverDocument } from './documentDelivery.js';
import { documentError } from './documentPlan.js';
import { digest } from './documentXml.js';
import { S, str } from './documentSchema.js';
export const structuredOperationSchema = S(
  {
    action: { type: 'string', enum: ['format', 'table_layout', 'page_layout', 'update_toc', 'move_resize', 'rotate_pages', 'reorder_pages', 'crop_pages'] },
    target: S({
      id: str('结构读取返回的id'),
      role: { type: 'string', enum: ['title', 'heading', 'body', 'table'] },
      text: str('精确全文；重名时改用id'),
      page: { type: 'integer', minimum: 1 },
      pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 120 },
      sheet: str('工作表名'),
      range: str('A1:B10')
    }),
    properties: S({
      heading_level: { type: 'integer', minimum: 1, maximum: 9 },
      font_size: { type: 'number' },
      font_family: str('字体名'),
      bold: { type: 'boolean' },
      underline: { type: 'boolean' },
      alignment: str('Word:left/center/right/both；PPT/Excel:left/center/right/justify'),
      color: str('六位HEX'),
      space_before: { type: 'number' },
      space_after: { type: 'number' },
      line_spacing: { type: 'number' },
      keep_next: { type: 'boolean' },
      page_break_before: { type: 'boolean' },
      remove_lines: { type: 'boolean' },
      repeat_header: { type: 'boolean' },
      keep_rows: { type: 'boolean' },
      keep_table: { type: 'boolean' },
      top: { type: 'number' },
      bottom: { type: 'number' },
      left: { type: 'number' },
      right: { type: 'number' },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      fit_width: { type: 'integer' },
      fit_height: { type: 'integer' },
      wrap_text: { type: 'boolean' },
      number_format: str('Excel数字格式'),
      angle: { type: 'integer' },
      order: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 120 }
    })
  },
  ['action']
);
export const documentStructureTool = {
  name: 'read_document_structure',
  description:
    '编辑已有Word/PPT/Excel/PDF前读取真实结构、对象id、sha256和支持的操作。把用户自然语言转成edit_office_document的operations，局部要求用id，整体同类用role；禁止照抄正文重新生成来冒充精确编辑。返回分页摘要，不包含全部正文；未支持的能力不得承诺。',
  input_schema: S({ path: str('已有文档路径'), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['path']),
  run: async ({ path, offset, limit }, options = {}) =>
    JSON.stringify(await inspectEditableDocument(await ws.readBlob(path), ws.ext(path), { offset, limit, signal: options.signal }))
};
export async function runStructuredEdit(ctx, { path, operations, expected_sha256: expectedDigest, save_as: saveAs }, options = {}) {
  const kind = ws.ext(path),
    source = await ws.readBlob(path);
  const edited = await applyStructuredEdits(source, kind, operations, { expectedDigest, signal: options.signal });
  let toc;
  if (kind === 'docx' && edited.updateToc) {
    toc = await refreshWordToc(ctx, edited.blob, options);
    edited.blob = toc.blob;
  }
  options.signal?.throwIfAborted();
  if ((await digest(await ws.readBlob(path))) !== expectedDigest) throw documentError('编辑期间源文件发生变化，未覆盖', 'DOCUMENT_CONFLICT');
  const target = saveAs || path.replace(/\.[^.]+$/, `_编辑.${kind}`);
  if (ws.normalize(target) === ws.normalize(path)) throw documentError('结构编辑必须另存文件，原稿保留', 'DOCUMENT_SOURCE');
  const saved = await deliverDocument(
    ctx,
    {
      blob: edited.blob,
      ext: kind,
      structuredEdit: true,
      tocUpdate: toc && { state: toc.state, entries: toc.entries, passes: toc.passes },
      officePreview: toc?.preview
    },
    target,
    { ...options, preservation: edited.preservation, requirements: options.rawRequestText || options.requestText || '' }
  );
  return JSON.stringify({
    path: saved.path,
    source: path,
    changes: edited.changes,
    toc: toc && { state: toc.state, entries: toc.entries, passes: toc.passes },
    validation: saved.validation,
    notes: saved.notes,
    originalPreserved: true
  });
}
