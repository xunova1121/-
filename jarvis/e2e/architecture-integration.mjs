/** 虚构应用集成：语义模型只作编排桩，四格式与原生PPT对照使用真实渲染器。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { sceneElements } from '../src/agent/diagramScene.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-integration-native');
await fs.mkdir(output, { recursive: true });
const source = '虚构原文/协作系统集成要求.md';
const excerpt = '示范应用平台与协作业务系统进行应用级集成。';
await workspace.write(source, excerpt);
const proof = { source, excerpt };
const spec = {
  title: '虚构平台应用级集成', sources: [{ path: source, excerpt }],
  entities: ['应用平台', '协作系统'].map(id => ({ id, title: id, kind: 'system', responsibility: '承担本系统登记的业务职责', inputs: [], outputs: [], ...proof })),
  relations: [{ from: '应用平台', to: '协作系统', type: 'integration', meaning: '应用级集成', ...proof }],
  requirements: [{ text: excerpt, entities: ['应用平台', '协作系统'], ...proof }]
};
let modelCalls = 0;
const ctx = { renderSvg, compareDiagramPpt, llm: async () => { modelCalls++; return '{"passed":true,"issues":[]}'; } };
const plan = JSON.parse(await createArchitecturePlanTool(ctx).run(spec));
assert.equal(plan.readyForRender, true);
const text = await createDiagramTool(ctx, { requireArchitecture: true }).run({
  architecturePath: plan.architecturePath, path: '虚构应用集成.svg', formats: ['svg', 'png', 'pdf', 'pptx'], pptxMode: 'editable', view: 'overview'
});
const receipt = JSON.parse(text.split('\n')[1]);
assert.equal(receipt.editable.passed, true, JSON.stringify(receipt.editable));
assert.deepEqual(new Set(receipt.artifacts.map(item => item.format)), new Set(['svg', 'png', 'pdf', 'pptx']));
assert.equal(new Set(receipt.artifacts.map(item => item.designHash)).size, 1);
const scene = JSON.parse(await workspace.readText(receipt.designPath));
const links = sceneElements(scene).filter(item => item.relationType === 'integration');
assert.equal(links.length, 1);
assert.equal(links[0].arrow, false); assert.equal(links[0].dash, 'dash');
const svg = await workspace.readText(receipt.sourcePath);
assert.ok(svg.includes('stroke-dasharray="6 4"')); assert.ok(!svg.includes('marker-end='));
const zip = await JSZip.loadAsync(await (await workspace.readBlob(receipt.primaryEditablePath)).arrayBuffer());
const xml = await zip.file('ppt/slides/slide1.xml').async('string');
for (const connector of xml.matchAll(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>/g)) {
  assert.ok(connector[0].includes('<a:prstDash val="dash"/>'));
  assert.ok(!/<a:(?:headEnd|tailEnd)\b[^>]*type="(?:triangle|stealth|arrow)"/.test(connector[0]));
}
for (const artifact of receipt.artifacts) {
  const blob = await workspace.readBlob(artifact.path);
  await fs.writeFile(path.join(output, path.basename(artifact.path)), new Uint8Array(await blob.arrayBuffer()));
}
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ ...receipt, semanticModel: 'synthetic_fixture', modelCalls }, null, 2));
assert.equal(modelCalls, 1);
console.log('通过：有源应用集成保持无向虚线，真实四格式同稿与原生PPT对照通过；未做客户业务或真机验收。');
