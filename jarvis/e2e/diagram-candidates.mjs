/** 真SVG/PNG及四格式导出，视觉接口为假模型；不宣称真实视觉质量通过。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformSpec } from './fixtures/diagram-platform.mjs';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
import { renderSvg } from '../server/svgRender.mjs';
import { imageFormat } from '../src/agent/imageFormat.js';
const output = path.resolve(process.argv[2] || '/tmp/diagram-candidates');
await fs.mkdir(output,{recursive:true});
let calls = 0;
const ctx = {renderSvg, visionLlm: async ({images}) => {
  calls++;
  assert.equal(images.length,calls === 1 ? 2 : 1);
  return JSON.stringify(calls === 1 ? {selected:1,passed:false,issues:[{kind:'spacing',detail:'假接口指定间距修复，仅测试流程'}]} : {selected:0,passed:true,issues:[]});
}};
const response = await createDiagramTool(ctx).run({...platformSpec,path:'候选示范.svg',quality:'compare',formats:['svg','png','pptx','pdf']});
const receipt = JSON.parse(response.split('\n')[1]);
assert.equal(calls,2);
assert.equal(receipt.preview.visual,'passed');
assert.equal(receipt.artifacts.length,4);
assert.equal(receipt.artifacts.find(item => item.format === 'png').path, '候选示范-预览.png');
assert.equal(new Set(receipt.artifacts.map(item=>item.designHash)).size,1);
const state = JSON.parse(await workspace.readText(receipt.candidateStatePath));
assert.equal(state.candidates.length,3);
for (const [index,candidate] of state.candidates.entries()) {
  const blob = await workspace.readBlob(candidate.previewPath);
  assert.equal((await imageFormat(blob)).ext,'png');
  await fs.writeFile(path.join(output,`candidate-${index}.png`),new Uint8Array(await blob.arrayBuffer()));
}
for (const artifact of receipt.artifacts) await fs.writeFile(path.join(output,path.basename(artifact.path)),new Uint8Array(await (await workspace.readBlob(artifact.path)).arrayBuffer()));
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));
console.log('候选比较/一次修复/重新验收/真实PNG/四格式同稿：5/5；视觉模型为假接口');
