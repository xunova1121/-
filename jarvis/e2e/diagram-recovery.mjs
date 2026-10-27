/** 虚构材料，真实SVG/PNG/PDF/PPT交付；只验证修复与版本绑定，不冒充真实模型业务审查。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-diagram-recovery');
await fs.mkdir(output,{recursive:true});
await workspace.write('选定材料.md','虚构验证：配置雷达8套，接入数据服务。');
await workspace.write('旧材料.md','虚构旧版本：配置雷达9套。');
const tool = createDiagramTool({renderSvg});
const input={path:'恢复交付.svg',title:'虚构恢复验证',formats:['svg','png','pdf','pptx'],pptxMode:'display',
  layers:[{title:'感知层',nodes:[{id:'a',title:'雷达8套',detail:'接入数据服务'}]}],
  sources:[{path:'选定材料.md',excerpt:'配置雷达8套'}],
  contentPlan:{facts:[{source:'选定材料.md',text:'雷达8套',excerpt:'配置雷达9套'}]}};
await assert.rejects(tool.run(input),error=>error.code==='DIAGRAM_CONTENT_PLAN'&&error.diagnostics[0].field==='contentPlan.facts[0].excerpt');
assert.equal(await workspace.exists('恢复交付.svg'),false);
input.contentPlan.facts[0].excerpt='配置雷达8套';
const receipt=JSON.parse((await tool.run(input)).split('\n')[1]);
assert.equal(receipt.validation.render,'passed');
assert.equal(receipt.validation.visual,'not_checked');
assert.equal(new Set(receipt.artifacts.map(item=>item.designHash)).size,1);
assert.deepEqual(new Set(receipt.artifacts.map(item=>item.format)),new Set(['svg','png','pdf','pptx']));
for(const item of receipt.artifacts){const blob=await workspace.readBlob(item.path);assert.ok(blob.size>0);await fs.writeFile(path.join(output,path.basename(item.path)),new Uint8Array(await blob.arrayBuffer()));}
assert.equal(await workspace.readText('旧材料.md'),'虚构旧版本：配置雷达9套。');
assert.equal(await workspace.readText('选定材料.md'),'虚构验证：配置雷达8套，接入数据服务。');
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));
console.log('定点错误阻断、修复后真实四格式同稿、原材料保留通过；visual=not_checked。');
