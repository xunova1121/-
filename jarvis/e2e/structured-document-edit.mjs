/** 四格式真实文件修改与目录连续重排；不请求模型、不含用户原件。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generate, parseFile } from '../src/agent/docs.js';
import { createDocumentEditingTools } from '../src/agent/documentEditingTools.js';
import { inspectEditableDocument } from '../src/agent/structuredDocumentEdit.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { parseXml, descendants, wordText, attr } from '../src/agent/documentXml.js';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import { renderOffice } from '../server/officeRender.mjs';
import { presentationOverview } from '../server/presentationOverview.mjs';
import * as ws from '../src/agent/workspace.js';
import { PDFDocument } from 'pdf-lib';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-structured-edit-'));
const output = path.resolve(process.argv[2] || '/tmp/weiyang-structured-edit-artifacts');
useBackend(createFileStore(root));
const ctx = { officeRender: renderOffice, presentationOverview };
const tool = createDocumentEditingTools(ctx).find((t) => t.name === 'edit_office_document');
async function run(file, operations, saveAs) {
  const blob = await ws.readBlob(file),
    s = await inspectEditableDocument(blob, ws.ext(file));
  const r = JSON.parse(await tool.run({ path: file, operations, expected_sha256: s.sha256, save_as: saveAs }));
  assert.equal(r.validation.errors, 0, JSON.stringify(r.validation.issues));
  assert.ok(r.validation.pages > 0);
  assert.ok(r.validation.overviewPaths.length > 0, '需要真实PDF截图');
  assert.deepEqual(new Uint8Array(await (await ws.readBlob(file)).arrayBuffer()), new Uint8Array(await blob.arrayBuffer()), '原件保持');
  return r;
}
try {
  const content = Array.from(
    { length: 3 },
    (_, i) =>
      `# 第${i + 1}章\n\n` +
      Array.from({ length: 12 }, (_, j) => `第${i + 1}章第${j + 1}条：合成测试资料用于核对连续编辑后的正文保留、目录页码和分页。`).join('\n\n')
  ).join('\n\n');
  const original = await generate('docx', { title: '连续编辑测试', content, toc: true });
  await ws.write('测试/原稿.docx', original.blob);
  const first = await run('测试/原稿.docx', [{ action: 'update_toc' }], '测试/目录版.docx');
  assert.equal(first.toc.state, 'updated_verified');
  const second = await run(
    '测试/目录版.docx',
    [
      { action: 'format', target: { role: 'body' }, properties: { font_size: 20, line_spacing: 1.5 } },
      { action: 'format', target: { role: 'heading' }, properties: { remove_lines: true, underline: false } }
    ],
    '测试/大字版.docx'
  );
  assert.equal(second.toc.state, 'updated_verified');
  assert.ok(second.validation.pages > first.validation.pages, '放大正文后实际页数增加');
  const readToc = async (file) => {
    const zip = await openOfficePackage(await ws.readBlob(file));
    const doc = parseXml(await zip.file('word/document.xml').async('string'));
    return descendants(doc, 'w', 'sdt')
      .filter((node) => descendants(node, 'w', 'instrText').some((field) => /\bTOC\b/.test(field.textContent)))
      .map(wordText)
      .join('');
  };
  assert.ok(await readToc(first.path), '原目录缓存必须非空');
  assert.ok(await readToc(second.path), '修改后目录缓存必须非空');
  assert.notEqual(await readToc(first.path), await readToc(second.path), '目录必须随着实际分页改变');
  const parsed = await parseFile(await ws.readBlob(second.path), '大字版.docx');
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 12; j++) assert.ok(parsed.text.includes(`第${i}章第${j}条`));
  const ppt = await generate('pptx', { title: '精确元素测试', content: '# 第一页\n\n保留文字甲\n\n---\n\n# 第二页\n\n保留文字乙', cover: false });
  await ws.write('测试/演示.pptx', ppt.blob);
  const ps = await inspectEditableDocument(ppt.blob, 'pptx');
  const target = ps.objects.find((o) => o.kind === 'sp' && o.text === '保留文字甲');
  assert.ok(target);
  const p = await run(
    '测试/演示.pptx',
    [{ action: 'format', target: { id: target.id }, properties: { font_size: 24, color: '123456' } }],
    '测试/演示编辑.pptx'
  );
  const Excel = (await import('exceljs')).default;
  const book = new Excel.Workbook(),
    sheet = book.addWorksheet('预算');
  sheet.addRow(['项目', '金额', '合计']);
  sheet.addRow(['甲', 12, { formula: 'B2*2', result: 24 }]);
  await ws.write('测试/预算.xlsx', new Blob([await book.xlsx.writeBuffer()]));
  const x = await run(
    '测试/预算.xlsx',
    [
      { action: 'format', target: { sheet: '预算', range: 'A1:C2' }, properties: { font_size: 16, wrap_text: true } },
      { action: 'page_layout', target: { sheet: '预算' }, properties: { orientation: 'landscape', fit_width: 1, fit_height: 0 } }
    ],
    '测试/预算编辑.xlsx'
  );
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.addPage([500, 600]);
  await ws.write('测试/页面.pdf', new Blob([await pdf.save()]));
  const d = await run(
    '测试/页面.pdf',
    [
      { action: 'reorder_pages', properties: { order: [2, 1] } },
      { action: 'rotate_pages', target: { pages: [1] }, properties: { angle: 90 } }
    ],
    '测试/页面编辑.pdf'
  );
  assert.equal(d.validation.pages, 2);
  await fs.mkdir(output, { recursive: true });
  for (const r of [first, second, p, x, d]) {
    for (const file of [r.path, ...r.validation.overviewPaths])
      await fs.writeFile(path.join(output, path.basename(file)), new Uint8Array(await (await ws.readBlob(file)).arrayBuffer()));
  }
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        wordBefore: first.validation.pages,
        wordAfter: second.validation.pages,
        toc: second.toc,
        ppt: p.validation.pages,
        xlsx: x.validation.pages,
        pdf: d.validation.pages,
        realModel: false
      },
      null,
      2
    )
  );
  console.log('通过：四格式真实编辑与截图；Word目录连续重排页码更新，正文保留、原件不改。未请求真实模型。');
} finally {
  useBackend(null);
  await fs.rm(root, { recursive: true, force: true });
}
