/** 虚构材料：程序取证据编号→模型只引用编号→真实四格式同稿与原生PPT验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec } from './fixtures/architecture-plan.mjs';
import { createArchitectureEvidenceTool } from '../src/agent/architectureEvidenceTool.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createArchitecturePackageTool } from '../src/agent/architecturePackage.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-architecture-package');
await fs.mkdir(output, { recursive: true });
const spec = structuredClone(architectureSpec);
// 额外虚构变体：现场处置反馈到调度，专测相邻节点正反双向路线。
if (process.argv[3] === 'parallel') for (const relation of spec.relations) if (relation.type === 'feedback') relation.to = 'dispatch';
const byId = new Map(spec.entities.map(item => [item.id, item.title]));
const entityText = item => `${item.title}：${item.responsibility}。`;
const relationText = item => `${byId.get(item.from)}→${byId.get(item.to)}：${item.meaning}。`;
const requirement = spec.requirements[0].text;
const lines = [...spec.entities.map(entityText), ...spec.relations.map(relationText), requirement];
await workspace.write('合成采购.md', lines.map(line => line + ' '.repeat(130)).join('\n'));
const sources = [{ path: '合成采购.md' }];
const evidence = [];
let offset = 0;
do {
  const page = JSON.parse(await createArchitectureEvidenceTool().run({ sources, offset, limit: 20 }));
  evidence.push(...page.items);
  offset = page.nextOffset;
} while (offset !== null);
const idFor = text => {
  const proof = evidence.find(item => item.text.includes(text));
  assert.ok(proof, '原文证据须存在，不手填摘录替代');
  return proof.evidenceId;
};
for (const entity of spec.entities) { entity.evidenceId = idFor(entityText(entity)); delete entity.assumption; }
for (const relation of spec.relations) { relation.evidenceId = idFor(relationText(relation)); delete relation.assumption; }
spec.requirements = [{ text: requirement, entities: spec.requirements[0].entities, evidenceId: idFor(requirement) }];
spec.sources = sources;
let calls = 0;
const ctx = { renderSvg, compareDiagramPpt, llm: async () => { calls++; return '{"passed":true,"issues":[]}'; } };
const plan = JSON.parse(await createArchitecturePlanTool(ctx).run(spec, { rawRequestText: requirement }));
assert.equal(calls, 1);
assert.equal(plan.readyForRender, true);
const saved = JSON.parse(await workspace.readText(plan.architecturePath));
assert.ok(saved.entities.every(item => item.evidenceId && item.source === '合成采购.md' && item.evidence === 'excerpt_matched'));
assert.ok(saved.relations.every(item => item.evidenceId && item.evidence === 'excerpt_matched'));
let receipt;
try { receipt = JSON.parse(await createArchitecturePackageTool(ctx).run({ architecturePath: plan.architecturePath, directory: '合成交付' }, { rawRequestText: '交付完整多视图架构图' })); } catch (error) {
  if (error.statePath) await fs.writeFile(path.join(output, 'failed-manifest.json'), await workspace.readText(error.statePath));
  throw error;
}
assert.equal(receipt.status, 'complete');
assert.deepEqual(receipt.completedViews.map(item => item.view), ['overview', 'workflow', 'dataflow']);
for (const view of receipt.completedViews) {
  assert.equal(view.editable, true);
  const folder = path.join(output, view.view);
  await fs.mkdir(folder, { recursive: true });
  for (const artifact of view.files) {
    const blob = await workspace.readBlob(artifact.path);
    assert.ok(blob.size > 0);
    await fs.writeFile(path.join(folder, path.basename(artifact.path)), new Uint8Array(await blob.arrayBuffer()));
  }
}
// 再次调用必须核对实际文件后复用；若触发任一渲染/对照则测试失败。
const unexpected = () => { throw new Error('已完成且未变更的视图不应重新渲染'); };
const resumed = JSON.parse(await createArchitecturePackageTool({ ...ctx, renderSvg: unexpected, compareDiagramPpt: unexpected }).run({ architecturePath: plan.architecturePath, directory: '合成交付' }));
assert.equal(resumed.status, 'complete');
assert.deepEqual(resumed.reusedViews, ['overview', 'workflow', 'dataflow']);
assert.deepEqual(resumed.completedViews, receipt.completedViews);
assert.equal(calls, 1, '复用实际交付不能重做业务审查');
await fs.writeFile(path.join(output, 'resume-receipt.json'), JSON.stringify(resumed, null, 2));
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log('通过：同一证据编号底稿的总体/闭环/数据流三个视图均实际交付四格式和原生PPT，清单核对通过；未替代客户验收。');
