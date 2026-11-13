/** 合成材料：审查指出具体角色错误→定点修订→真实四格式输出，原生PPT门槛保持。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec, architectureLayout } from './fixtures/architecture-plan.mjs';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createArchitectureRevisionTool } from '../src/agent/architectureRevision.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-architecture-revision');
await fs.mkdir(output, { recursive: true });
let calls = 0;
const ctx = { renderSvg, compareDiagramPpt, llm: async () => (++calls === 1 ? '{"passed":false,"issues":[{"target":"entity:events","kind":"classification","detail":"事件数据应按信息对象归入数据层"}]}' : '{"passed":true,"issues":[]}') };
const source = structuredClone(architectureSpec);
source.entities.find(item => item.id === 'events').kind = 'application';
const initial = JSON.parse(await createArchitecturePlanTool(ctx).run(source, { rawRequestText: '建设示范业务闭环，统一权限与审计' }));
const old = await workspace.readText(initial.architecturePath);
assert.equal(initial.semantic, 'failed');
const plan = JSON.parse(await createArchitectureRevisionTool(ctx).run({ architecturePath: initial.architecturePath, reason: '按意见修正事件数据角色', changes: { entities: [{ id: 'events', kind: 'data' }] } }, { rawRequestText: '按意见继续修正' }));
assert.equal(await workspace.readText(initial.architecturePath), old);
assert.equal(JSON.parse(await workspace.readText(plan.architecturePath)).revision.parentPath, initial.architecturePath);
assert.equal(plan.readyForRender, true);
const before = await workspace.readText(plan.architecturePath);
const result = await createDiagramTool(ctx, { requireArchitecture: true }).run(
  {
    ...structuredClone(architectureLayout),
    architecturePath: plan.architecturePath,
    path: '定点修订架构.svg',
    formats: ['svg', 'png', 'pdf', 'pptx'],
    pptxMode: 'editable'
  },
  { rawRequestText: '继续制作正式架构图' }
);
const receipt = JSON.parse(result.split('\n')[1]);
assert.equal(calls, 2);
assert.equal(await workspace.readText(plan.architecturePath), before);
assert.equal(JSON.parse(await workspace.readText(plan.reviewPath)).semantic, 'passed');
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
console.log('通过：业务审查失败后按具体意见修订，仅修改目标角色，旧稿与未改证据保留，真实四格式/原生PPT对照通过；不冒充真实业务模型验收。');
