/** 合成Word原件含表格与真实PNG，实际工具重排并用Office/PDF核对文字和图像。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generate, parseFile, loadPdfjs } from '../src/agent/docs.js';
import { createTools } from '../src/agent/tools.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import * as ws from '../src/agent/workspace.js';
import * as sessions from '../src/agent/sessions.js';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
import { renderSvg } from '../server/svgRender.mjs';

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-file-source-e2e-'));
const output = path.resolve(process.argv[2] || '/tmp/weiyang-word-file-source');
useBackend(createFileStore(folder));
try {
  assert.ok(await officeRenderAvailable(), '真实Office不可用，不能跳过');
  const image = await renderSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#163f70"/><circle cx="80" cy="40" r="24" fill="#f0a33a"/></svg>'
  );
  const material =
    '# 合成Word原件\n\n## 业务范围\n\n全部内容均为合成测试资料。验收后付款1234.56元。\n\n| 项目 | 数量 |\n|---|---|\n| 传感器 | 17 |\n| 网关 | 3 |\n\n![合成示意图](test.png)';
  const original = await generate('docx', { content: material, theme: 'business', loadImage: async () => new Uint8Array(await image.arrayBuffer()) });
  await ws.write('上传/原件.docx', original.blob);
  const request = '按照我的偏好重新做一版\n\n[已上传到工作区：上传/原件.docx]';
  const session = sessions.create({ messages: [{ role: 'user', content: request }] });
  await sessions.save(session);
  const tool = createTools({
    officeRender: renderOffice,
    reasonLlm: async () => {
      throw new Error('原件排版不应调用改写模型');
    }
  }).find((item) => item.name === 'create_document');
  await tool.run(
    { format: 'docx', path: '上传/原件.docx', content: '# 旧稿\n\n不应交付', theme: 'gongwen' },
    { sessionId: session.id, rawRequestText: request }
  );
  const docx = await ws.readBlob('上传/原件_排版.docx');
  assert.deepEqual(new Uint8Array(await (await ws.readBlob('上传/原件.docx')).arrayBuffer()), new Uint8Array(await original.blob.arrayBuffer()));
  const before = await openOfficePackage(original.blob);
  const after = await openOfficePackage(docx);
  for (const key of Object.keys(before.files).filter((key) => !before.files[key].dir && key !== 'word/styles.xml'))
    assert.deepEqual(await after.file(key).async('uint8array'), await before.file(key).async('uint8array'), key);
  const report = JSON.parse(await ws.readText('上传/文档检查/原件_排版-docx.json'));
  assert.equal(report.contentPreservation.state, 'passed');
  assert.equal(report.render, 'converted_not_visual_reviewed');
  assert.equal(report.errors, 0);
  const pdf = await ws.readBlob(report.previewPath);
  const parsed = await parseFile(pdf, 'preview.pdf');
  for (const text of ['合成Word原件', '1234.56', '传感器', '17', '网关']) assert.ok(parsed.text.replace(/\s/g, '').includes(text), text);
  const pdfjs = await loadPdfjs();
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), isEvalSupported: false }).promise;
  let pictures = 0;
  try {
    for (let page = 1; page <= loaded.numPages; page++) {
      const ops = await (await loaded.getPage(page)).getOperatorList();
      pictures += ops.fnArray.filter((op) => op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject).length;
    }
  } finally {
    await loaded.destroy();
  }
  assert.ok(pictures > 0, '实际PDF必须仍然绘制图片');
  await fs.mkdir(output, { recursive: true });
  for (const [file, blob] of [
    ['restyled.docx', docx],
    ['restyled.pdf', pdf]
  ])
    await fs.writeFile(path.join(output, file), new Uint8Array(await blob.arrayBuffer()));
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2));
  console.log('通过：真实原Word正文/表格/图片关联保持，原件不改；实际PDF文字和图片存在，未冒充视觉模型验收。');
} finally {
  useBackend(null);
  await fs.rm(folder, { recursive: true, force: true });
}
