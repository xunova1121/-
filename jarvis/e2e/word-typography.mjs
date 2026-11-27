/** 真实Office验收：指定字号不改、分页协调保留全文、不可满足时真实失败；不调用模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import * as ws from '../src/agent/workspace.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { generate, parseFile, loadPdfjs } from '../src/agent/docs.js';
import { typographyFromText } from '../src/agent/documentTypography.js';
import { inspectRenderedPdf } from '../src/agent/pdfQuality.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-word-typography');
await fs.mkdir(output, { recursive: true });
const store = await fs.mkdtemp('/tmp/weiyang-word-type-store-');
useBackend(createFileStore(store));
const title = '排版验收样例';
const styleRequest = '正文Noto Sans CJK SC四号，主标题Noto Sans CJK SC二号，不要封面，不要目录';
const paragraphList = count => Array.from({ length: count }, (_, i) => `第${String(i + 1).padStart(2, '0')}项：本材料为虚构验收内容，保留设备数量17台，金额1234.56元，完成后逐项核对。`);
const documentText = paragraphs => '# ' + title + '\n\n' + paragraphs.join('\n\n');

/** 只校准虚构输入，不改生产协调器：至多12次测量/96段，二分找刚超过2页的原稿。 */
async function calibrateSample() {
  const attempts = [];
  const probe = async count => {
    assert.ok(attempts.length < 12, '样例校准超过12次真实渲染，不能无界重试');
    const paragraphs = paragraphList(count);
    const out = await generate('docx', { title, content: documentText(paragraphs), theme: 'business', kind: 'general', cover: false, toc: false, typography: typographyFromText(styleRequest) });
    // 校准本身失败也留最后一份输入/预览，不能只剩一句断言报错。
    await fs.writeFile(path.join(output, 'calibration-latest.docx'), new Uint8Array(await out.blob.arrayBuffer()));
    const rendered = await renderOffice(out.blob, 'docx');
    assert.ok(rendered.available && rendered.blob, '校准需要真实Office，不能猜页数');
    await fs.writeFile(path.join(output, 'calibration-latest.pdf'), new Uint8Array(await rendered.blob.arrayBuffer()));
    const checked = await inspectRenderedPdf(rendered.blob);
    attempts.push({ paragraphs: count, pages: checked.pages, issues: checked.issues });
    await fs.writeFile(path.join(output, 'calibration.json'), JSON.stringify({ targetPages: 2, attempts }, null, 2));
    assert.equal(checked.issues.length, 0, '校准原稿已有可疑文字边界或空白页');
    assert.ok(Number.isInteger(checked.pages) && checked.pages > 0);
    console.log(JSON.stringify({ calibration: attempts.at(-1) }));
    return { paragraphs, pages: checked.pages, docx: out.blob, pdf: rendered.blob };
  };
  let lower = 0, upper = 12, sample = await probe(upper);
  while (sample.pages <= 2 && upper < 96) {
    lower = upper;
    upper = Math.min(96, upper * 2);
    sample = await probe(upper);
  }
  assert.ok(sample.pages > 2, '96段内未构造出超过2页的原稿，不能把未触发协调算通过');
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = await probe(middle);
    if (candidate.pages > 2) { upper = middle; sample = candidate; }
    else lower = middle;
  }
  await fs.writeFile(path.join(output, '校准原稿.docx'), new Uint8Array(await sample.docx.arrayBuffer()));
  await fs.writeFile(path.join(output, '校准原稿.pdf'), new Uint8Array(await sample.pdf.arrayBuffer()));
  return { ...sample, measurements: attempts.length };
}
try {
  assert.ok(await officeRenderAvailable(), '需要真实Office，不能跳过');
  const calibrated = await calibrateSample();
  const paragraphs = calibrated.paragraphs;
  const content = documentText(paragraphs);
  const tool = createDocumentGenerateTool({ officeRender: renderOffice });
  await tool.run({ format: 'docx', path: '分页.docx', title, content, theme: 'business', kind: 'general', template: 'none', requirements: '制作Word总共2页，' + styleRequest, toc: 'no', cover: false });
  const report = JSON.parse(await ws.readText('文档检查/分页-docx.json'));
  await fs.writeFile(path.join(output, 'initial-receipt.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(output, '分页.docx'), new Uint8Array(await (await ws.readBlob('分页.docx')).arrayBuffer()));
  if (report.previewPath) await fs.writeFile(path.join(output, '分页.pdf'), new Uint8Array(await (await ws.readBlob(report.previewPath)).arrayBuffer()));
  console.log(JSON.stringify({ pageBudget: report.wordPageBudget, layout: report.wordLayout, render: report.render }));
  assert.equal(report.wordPageBudget.state, 'passed');
  assert.equal(report.wordPageBudget.actual, 2);
  assert.ok(report.wordLayout.renders > 1, '必须实际触发有界协调，不仅测试本来就达标');
  assert.ok(report.wordLayout.renders <= 4, '生产分页协调仍最多4次真实渲染');
  assert.equal(report.wordLayout.originalPages, calibrated.pages, '校准必须与实际工具的原始布局一致');
  assert.ok(report.wordLayout.originalPages > 2, '原稿必须真正超过目标页数');
  assert.equal(report.errors, 0);
  const docx = await ws.readBlob('分页.docx'), pdf = await ws.readBlob(report.previewPath);
  const zip = await openOfficePackage(docx);
  const xml = await zip.file('word/document.xml').async('string');
  for (const text of paragraphs) assert.ok(xml.includes(text), '正文不许为分页删改');
  const styles = await zip.file('word/styles.xml').async('string');
  assert.ok(styles.includes('Noto Sans CJK SC'));
  assert.ok(styles.includes('w:val="28"'));
  const parsed = await parseFile(pdf, 'preview.pdf', { limit: Infinity });
  for (const term of ['第01项', `第${String(paragraphs.length).padStart(2, '0')}项`, '1234.56', '17']) assert.ok(parsed.text.replace(/\s/g, '').includes(term));
  for (const paragraph of paragraphs) assert.ok(parsed.text.replace(/\s/g, '').includes(paragraph.replace(/\s/g, '')), '真实PDF也必须保留每一项全文');
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
  await fs.writeFile(path.join(output, 'conflict-receipt.json'), JSON.stringify(conflict, null, 2));
  await fs.writeFile(path.join(output, '约束冲突.docx'), new Uint8Array(await (await ws.readBlob('约束冲突.docx')).arrayBuffer()));
  if (conflict.previewPath) await fs.writeFile(path.join(output, '约束冲突.pdf'), new Uint8Array(await (await ws.readBlob(conflict.previewPath)).arrayBuffer()));
  assert.equal(conflict.wordPageBudget.state, 'failed');
  assert.equal(conflict.wordLayout.state, 'conflict');
  assert.equal(conflict.wordLayout.renders, 1, '明确行段距不能反复改写');
  assert.ok(conflict.errors > 0);
  const conflictZip = await openOfficePackage(await ws.readBlob('约束冲突.docx'));
  for (const text of paragraphs) assert.ok((await conflictZip.file('word/document.xml').async('string')).includes(text));
  for (const [file, blob] of [['分页.docx', docx], ['分页.pdf', pdf], ['约束冲突.docx', await ws.readBlob('约束冲突.docx')], ['约束冲突.pdf', await ws.readBlob(conflict.previewPath)]])
    await fs.writeFile(path.join(output, file), new Uint8Array(await blob.arrayBuffer()));
  await fs.writeFile(path.join(output, '验收.json'), JSON.stringify({ calibration: { paragraphs: paragraphs.length, originalPages: calibrated.pages, measurements: calibrated.measurements }, typography: report.typography, pagination: report.wordLayout, actualPages: report.pages, conflict: conflict.wordLayout, physicalBodySize: 14, assertions: `全文${paragraphs.length}项/金额/数量保持，真实PDF字号，实际2页，明确约束冲突不伪装成功`, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ output, pagination: report.wordLayout, conflict: conflict.wordLayout }, null, 2));
} finally { useBackend(null); await fs.rm(store, { recursive: true, force: true }); }
