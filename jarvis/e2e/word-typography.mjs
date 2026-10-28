/** 真实Office验收：指定字号不改、分页协调保留全文、不可满足时真实失败；不调用模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import * as ws from '../src/agent/workspace.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { parseFile, loadPdfjs } from '../src/agent/docs.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-word-typography');
await fs.mkdir(output, { recursive: true });
const store = await fs.mkdtemp('/tmp/weiyang-word-type-store-');
useBackend(createFileStore(store));
try {
  assert.ok(await officeRenderAvailable(), '需要真实Office，不能跳过');
  const paragraphs = Array.from({ length: 24 }, (_, i) => `第${String(i + 1).padStart(2, '0')}项：本材料为虚构验收内容，保留设备数量17台，金额1234.56元，完成后逐项核对。`);
  const content = '# 排版验收样例\n\n' + paragraphs.join('\n\n');
  const tool = createDocumentGenerateTool({ officeRender: renderOffice });
  await tool.run({ format: 'docx', path: '分页.docx', content, requirements: '制作Word总共2页，正文Noto Sans CJK SC四号，主标题Noto Sans CJK SC二号，不要封面，不要目录', toc: 'no', cover: false });
  const report = JSON.parse(await ws.readText('文档检查/分页-docx.json'));
  await fs.writeFile(path.join(output, 'initial-receipt.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pageBudget: report.wordPageBudget, layout: report.wordLayout, render: report.render }));
  assert.equal(report.wordPageBudget.state, 'passed');
  assert.equal(report.wordPageBudget.actual, 2);
  assert.ok(report.wordLayout.renders > 1, '必须实际触发有界协调，不仅测试本来就达标');
  assert.equal(report.errors, 0);
  const docx = await ws.readBlob('分页.docx'), pdf = await ws.readBlob(report.previewPath);
  const zip = await openOfficePackage(docx);
  const xml = await zip.file('word/document.xml').async('string');
  for (const text of paragraphs) assert.ok(xml.includes(text), '正文不许为分页删改');
  const styles = await zip.file('word/styles.xml').async('string');
  assert.ok(styles.includes('Noto Sans CJK SC'));
  assert.ok(styles.includes('w:val="28"'));
  const parsed = await parseFile(pdf, 'preview.pdf', { limit: Infinity });
  for (const term of ['第01项', '第24项', '1234.56', '17']) assert.ok(parsed.text.replace(/\s/g, '').includes(term));
  const pdfjs = await loadPdfjs();
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), isEvalSupported: false }).promise;
  let physicalBody = false;
  try {
    for (let i = 1; i <= loaded.numPages; i++) {
      const tc = await (await loaded.getPage(i)).getTextContent();
      physicalBody ||= tc.items.some(item => item.str.includes('本材料') && Math.abs(Math.abs(item.transform[3]) - 14) < 0.1);
    }
  } finally { await loaded.destroy(); }
  assert.ok(physicalBody, '真实PDF正文仍须14磅，不能偷缩字号凑页数');
  await tool.run({ format: 'docx', path: '约束冲突.docx', content, requirements: '制作Word总共1页，正文Noto Sans CJK SC小一，固定行距40磅，段前0磅，段后0磅，不要封面，不要目录', toc: 'no', cover: false });
  const conflict = JSON.parse(await ws.readText('文档检查/约束冲突-docx.json'));
  assert.equal(conflict.wordPageBudget.state, 'failed');
  assert.equal(conflict.wordLayout.state, 'conflict');
  assert.equal(conflict.wordLayout.renders, 1, '明确行段距不能反复改写');
  assert.ok(conflict.errors > 0);
  const conflictZip = await openOfficePackage(await ws.readBlob('约束冲突.docx'));
  for (const text of paragraphs) assert.ok((await conflictZip.file('word/document.xml').async('string')).includes(text));
  for (const [file, blob] of [['分页.docx', docx], ['分页.pdf', pdf], ['约束冲突.docx', await ws.readBlob('约束冲突.docx')], ['约束冲突.pdf', await ws.readBlob(conflict.previewPath)]])
    await fs.writeFile(path.join(output, file), new Uint8Array(await blob.arrayBuffer()));
  await fs.writeFile(path.join(output, '验收.json'), JSON.stringify({ typography: report.typography, pagination: report.wordLayout, actualPages: report.pages, conflict: conflict.wordLayout, physicalBodySize: 14, assertions: '全文24项/金额/数量保持，真实PDF字号，实际2页，明确约束冲突不伪装成功', modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ output, pagination: report.wordLayout, conflict: conflict.wordLayout }, null, 2));
} finally { useBackend(null); await fs.rm(store, { recursive: true, force: true }); }
