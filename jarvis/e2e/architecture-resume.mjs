/** 合成材料：真实工具从审查失败恢复，同一底稿导出四种格式，原生PPT门槛保持。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec, architectureLayout } from './fixtures/architecture-plan.mjs';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-architecture-resume');
await fs.mkdir(output, { recursive: true });
let calls = 0;
const ctx = { renderSvg, compareDiagramPpt, llm: async () => (++calls === 1 ? '格式不符合约定' : '{"passed":true,"issues":[]}') };
const plan = JSON.parse(await createArchitecturePlanTool(ctx).run(architectureSpec, { rawRequestText: '建设示范业务闭环，统一权限与审计' }));
assert.equal(plan.readyForRender, false);
assert.equal(plan.reviewErrorCode, 'ARCHITECTURE_REVIEW_FORMAT');
const before = await workspace.readText(plan.architecturePath);
const result = await createDiagramTool(ctx, { requireArchitecture: true }).run(
  {
    ...structuredClone(architectureLayout),
    architecturePath: plan.architecturePath,
    path: '恢复架构.svg',
    formats: ['svg', 'png', 'pdf', 'pptx'],
    pptxMode: 'editable'
  },
  { rawRequestText: '继续制作正式架构图' }
);
const receipt = JSON.parse(result.split('\n')[1]);
assert.equal(calls, 2);
assert.equal(await workspace.readText(plan.architecturePath), before);
assert.equal(JSON.parse(await workspace.readText(plan.reviewPath)).resumeAttempts, 1);
assert.equal(receipt.architecture.semantic, 'passed');
assert.equal(receipt.editable.passed, true);
assert.deepEqual(new Set(receipt.artifacts.map((item) => item.format)), new Set(['svg', 'png', 'pdf', 'pptx']));
assert.equal(new Set(receipt.artifacts.map((item) => item.designHash)).size, 1);
for (const artifact of receipt.artifacts) {
  const blob = await workspace.readBlob(artifact.path);
  assert.ok(blob.size > 0);
  await fs.writeFile(path.join(output, path.basename(artifact.path)), new Uint8Array(await blob.arrayBuffer()));
}
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log('通过：同一底稿恢复一次业务审查后实际交付SVG/PNG/PDF/原生PPT，保持原生PPT对照门槛；不冒充真实模型业务验收。');
