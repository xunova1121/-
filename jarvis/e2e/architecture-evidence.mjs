/** 虚构材料：程序取证据编号→模型只引用编号→真实四格式同稿与原生PPT验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec, architectureLayout } from './fixtures/architecture-plan.mjs';
import { createArchitectureEvidenceTool } from '../src/agent/architectureEvidenceTool.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-architecture-evidence');
await fs.mkdir(output, { recursive: true });
const spec = structuredClone(architectureSpec);
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
const result = await createDiagramTool(ctx, { requireArchitecture: true }).run({
  ...structuredClone(architectureLayout), architecturePath: plan.architecturePath,
  path: '编号引用架构.svg', formats: ['svg', 'png', 'pdf', 'pptx'], pptxMode: 'editable'
}, { rawRequestText: '用已审底稿制作架构图' });
const receipt = JSON.parse(result.split('\n')[1]);
assert.equal(receipt.editable.passed, true);
assert.deepEqual(new Set(receipt.artifacts.map(item => item.format)), new Set(['svg', 'png', 'pdf', 'pptx']));
assert.equal(new Set(receipt.artifacts.map(item => item.designHash)).size, 1);
for (const artifact of receipt.artifacts) {
  const blob = await workspace.readBlob(artifact.path);
  assert.ok(blob.size > 0);
  await fs.writeFile(path.join(output, path.basename(artifact.path)), new Uint8Array(await blob.arrayBuffer()));
}
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log('通过：从合成采购原文取编号，仅引用编号构建底稿并真实交付四格式，原生PPT对照通过；不代表真实业务模型验收。');
