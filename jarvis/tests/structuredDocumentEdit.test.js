import { describe, it, expect } from 'vitest';
import { generate } from '../src/agent/docs.js';
import { inspectEditableDocument, applyStructuredEdits } from '../src/agent/structuredDocumentEdit.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { measureDocx, styleReport } from '../src/agent/styleCheck.js';
import { parseXml, descendants, attr, wordText } from '../src/agent/documentXml.js';
import { PDFDocument } from 'pdf-lib';
import { refreshWordToc } from '../src/agent/wordTableOfContents.js';
import { createDocumentEditingTools } from '../src/agent/documentEditingTools.js';
const fixture = async () =>
  (await generate('docx', { title: '工作报告', content: '# 工作报告\n\n## 计划\n\n正文保留。\n\n|项目|数量|\n|---|---|\n|甲|12|\n|乙|24|', toc: false })).blob;
const edit = async (blob, kind, operations) =>
  applyStructuredEdits(blob, kind, operations, { expectedDigest: (await inspectEditableDocument(blob, kind)).sha256 });
const xml = async (blob, path = 'word/document.xml') => (await openOfficePackage(blob)).file(path).async('string');
describe('可组合跨格式文档编辑', () => {
  it('结构按实际文件返回对象、版本和有界分页', async () => {
    const s = await inspectEditableDocument(await fixture(), 'docx', { limit: 2 });
    expect(s.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(s.objects).toHaveLength(2);
    expect(s.next).toBe(2);
    expect(s.capabilities.length).toBeGreaterThan(2);
  });
  it('旧摘要拒绝整批修改', async () => {
    await expect(
      applyStructuredEdits(await fixture(), 'docx', [{ action: 'format', target: { role: 'body' }, properties: { font_size: 16 } }], {
        expectedDigest: '0'.repeat(64)
      })
    ).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' });
  });
  it('去标题线同时处理独立装饰与样式继承，表格边框/正文保留', async () => {
    const b = await fixture();
    const r = await edit(b, 'docx', [
      { action: 'format', target: { role: 'title' }, properties: { remove_lines: true, underline: false } },
      { action: 'format', target: { role: 'heading' }, properties: { remove_lines: true, underline: false } }
    ]);
    expect((await measureDocx(r.blob)).rules).toBe(0);
    expect(wordText(parseXml(await xml(b)))).toBe(wordText(parseXml(await xml(r.blob))));
    const original = parseXml(await xml(b)),
      actual = parseXml(await xml(r.blob));
    expect(descendants(actual, 'w', 'tblBorders').length).toBe(descendants(original, 'w', 'tblBorders').length);
  });
  it('正文调大不改标题或表格字，也不丢图片关系部件', async () => {
    const b = await fixture();
    const before = parseXml(await xml(b));
    const r = await edit(b, 'docx', [
      { action: 'format', target: { role: 'body' }, properties: { font_size: 18, font_family: 'Noto Sans CJK SC', space_after: 12 } }
    ]);
    const after = parseXml(await xml(r.blob));
    const table = descendants(after, 'w', 'tbl')[0];
    expect(descendants(table, 'w', 'sz').map((n) => attr(n, 'val', 'w'))).toEqual(
      descendants(descendants(before, 'w', 'tbl')[0], 'w', 'sz').map((n) => attr(n, 'val', 'w'))
    );
    const a = await openOfficePackage(b),
      z = await openOfficePackage(r.blob);
    for (const path of Object.keys(a.files).filter((p) => p.includes('_rels') || p.includes('/media/')))
      expect(await z.file(path)?.async('base64')).toBe(await a.file(path)?.async('base64'));
  });
  it('不存在或重名目标拒绝，不擅自全文修改', async () => {
    await expect(edit(await fixture(), 'docx', [{ action: 'format', target: { id: 'p9999' }, properties: { font_size: 16 } }])).rejects.toMatchObject({
      code: 'DOCUMENT_SCOPE'
    });
  });
  it('未支持属性拒绝，不能悄悄忽略', async () => {
    await expect(edit(await fixture(), 'docx', [{ action: 'format', target: { role: 'body' }, properties: { nonsense: 1 } }])).rejects.toThrow('不支持');
  });
  it('标题下划线0但横线仍在不能判通过', () => {
    expect(styleReport('标题不要下划线', { format: 'docx', styleFacts: { rules: 4, underlines: 0 } })[0].state).not.toBe('done');
  });
  it('TOC请求缺真实渲染能力时拒绝，原文不变', async () => {
    const b = await fixture();
    const r = await edit(b, 'docx', [{ action: 'update_toc' }]);
    expect(r.updateToc).toBe(true);
    await expect(refreshWordToc({}, r.blob)).rejects.toMatchObject({ code: 'DOCUMENT_TOC' });
    expect(await xml(b)).not.toContain('目录待排版更新');
  });
  it('编辑工具实际暴露四格式结构读取和操作schema', () => {
    const tools = createDocumentEditingTools({});
    expect(tools.find((t) => t.name === 'read_document_structure')).toBeTruthy();
    expect(tools.find((t) => t.name === 'edit_office_document').input_schema.properties.operations.items.properties.action.enum).toContain('update_toc');
  });
  it('PPT只改指定元素，其他元素文本和媒体保留', async () => {
    const b = (await generate('pptx', { title: '示例', content: '# 页面\n\n说明文字', cover: false })).blob;
    const s = await inspectEditableDocument(b, 'pptx');
    const obj = s.objects.find((o) => o.kind === 'sp' && o.text);
    expect(obj).toBeTruthy();
    const r = await edit(b, 'pptx', [{ action: 'format', target: { id: obj.id }, properties: { font_size: 28, color: '123456' } }]);
    const next = await inspectEditableDocument(r.blob, 'pptx');
    expect(next.objects.map((o) => o.text)).toEqual(s.objects.map((o) => o.text));
  });
  it('Excel格式操作不改数值与公式，范围之外样式不变', async () => {
    const Excel = (await import('exceljs')).default;
    const wb = new Excel.Workbook(),
      s = wb.addWorksheet('预算');
    s.getCell('A1').value = 12;
    s.getCell('B1').value = { formula: 'A1*2', result: 24 };
    s.getCell('C1').value = '保留';
    const b = new Blob([await wb.xlsx.writeBuffer()]);
    const r = await edit(b, 'xlsx', [
      { action: 'format', target: { sheet: '预算', range: 'A1:B1' }, properties: { font_size: 18, bold: true, number_format: '0.00' } }
    ]);
    const before = parseXml(await xml(b, 'xl/worksheets/sheet1.xml')),
      after = parseXml(await xml(r.blob, 'xl/worksheets/sheet1.xml'));
    expect(descendants(after, 'x', 'f').map((n) => n.textContent)).toEqual(descendants(before, 'x', 'f').map((n) => n.textContent));
    expect(descendants(after, 'x', 'v').map((n) => n.textContent)).toEqual(descendants(before, 'x', 'v').map((n) => n.textContent));
    expect(attr(descendants(after, 'x', 'c')[2], 's')).toBe(attr(descendants(before, 'x', 'c')[2], 's'));
  });
  it('PDF页序旋转保留所有页面，拒绝用重排删页', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    pdf.addPage([500, 600]);
    const b = new Blob([await pdf.save()]);
    const r = await edit(b, 'pdf', [
      { action: 'reorder_pages', properties: { order: [2, 1] } },
      { action: 'rotate_pages', target: { pages: [1] }, properties: { angle: 90 } }
    ]);
    const p = await PDFDocument.load(await r.blob.arrayBuffer());
    expect(p.getPageCount()).toBe(2);
    expect(p.getPage(0).getWidth()).toBe(500);
    expect(p.getPage(0).getRotation().angle).toBe(90);
    await expect(edit(b, 'pdf', [{ action: 'reorder_pages', properties: { order: [1] } }])).rejects.toThrow('全部原页');
  });
  it('PDF正文涂改不冒充可支持', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await expect(edit(new Blob([await pdf.save()]), 'pdf', [{ action: 'replace_text', target: { pages: [1] }, properties: {} }])).rejects.toMatchObject({
      code: 'DOCUMENT_UNSUPPORTED'
    });
  });
});
