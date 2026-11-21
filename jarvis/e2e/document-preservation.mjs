/** 虚构材料，实际工具→DOCX读回→LibreOffice PDF，不使用真实模型或客户正文。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import * as ws from '../src/agent/workspace.js';
import { createTools } from '../src/agent/tools.js';
import { parseFile } from '../src/agent/docs.js';
import { verifyFormattingContent } from '../src/agent/documentPreservation.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-document-preservation');
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-preserve-e2e-'));
useBackend(createFileStore(store));
try {
  assert.ok(await officeRenderAvailable(), '必须有实际Office渲染，不能跳过');
  const original =
    '# 合成正文保留测试\n\n## 业务范围\n\n正文必须完整保留，不能换成旧摘要。\n\n| 项目 | 数量 |\n|---|---|\n| 传感器 | 17 |\n| 网关 | 3 |\n\n## 付款约定\n\n验收后支付1234.56元。';
  const session = sessions.create({
    messages: [
      { role: 'user', content: '# 旧文档\n\n不应该交付旧稿。' },
      { role: 'user', content: original },
      { role: 'user', content: '只调整排版，正文不变' }
    ]
  });
  await sessions.save(session);
  const tool = createTools({
    officeRender: renderOffice,
    reasonLlm: async () => {
      throw new Error('排版不应调用改写审稿');
    }
  }).find((item) => item.name === 'create_document');
  await tool.run(
    { format: 'docx', path: '验证/正文保留.docx', content: '# 旧文档\n\n模型误传旧稿。' },
    { sessionId: session.id, rawRequestText: '只调整排版，正文不变' }
  );
  const docx = await ws.readBlob('验证/正文保留.docx');
  assert.equal((await verifyFormattingContent(docx, original)).state, 'passed');
  const report = JSON.parse(await ws.readText('验证/文档检查/正文保留-docx.json'));
  assert.equal(report.contentPreservation.state, 'passed');
  assert.equal(report.render, 'converted_not_visual_reviewed');
  assert.equal(report.errors, 0);
  const preview = await ws.readBlob(report.previewPath);
  const pdf = await parseFile(preview, 'preview.pdf');
  for (const text of ['正文必须完整保留', '传感器', '17', '网关', '1234.56']) assert.ok(pdf.text.includes(text), `实际PDF缺少${text}`);
  await fs.mkdir(output, { recursive: true });
  for (const [file, blob] of [
    ['preserved.docx', docx],
    ['preserved.pdf', preview]
  ])
    await fs.writeFile(path.join(output, file), new Uint8Array(await blob.arrayBuffer()));
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2));
  console.log('通过：旧稿干扰下原文及表格/数字保留，实际Word与PDF读回；未作视觉模型验收。');
} finally {
  useBackend(null);
  await fs.rm(store, { recursive: true, force: true });
}
