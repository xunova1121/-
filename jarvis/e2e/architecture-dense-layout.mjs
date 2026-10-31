/** 虚构园区密集总览：假业务模型只用于编排回归，四格式与原生PPT使用真实Office检查。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec } from './fixtures/architecture-plan.mjs';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { loadArchitecture, projectArchitecture } from '../src/agent/architectureProjection.js';
import { businessArchitectureLayout } from '../src/agent/architectureLayout.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { renderSvg } from '../server/svgRender.mjs';
import * as workspace from '../src/agent/workspace.js';
const output=path.resolve(process.argv[2] || '/tmp/weiyang-dense-layout');
await fs.mkdir(output,{recursive:true});
const spec=structuredClone(architectureSpec);
spec.title='示范园区协同平台总体架构';
spec.entities=spec.entities.filter(item=>!['pc','mobile','sensing','sensors'].includes(item.id));
const ids=new Set(spec.entities.map(item=>item.id));
spec.relations=spec.relations.filter(item=>ids.has(item.from)&&ids.has(item.to));
for(let i=0;i<8;i++){
  const id='module'+i;
  spec.entities.push({id,title:['值班管理','人员档案','资源采集','设备台账','知识查询','报表统计','消息中心','运营管理'][i],kind:'application',responsibility:'维护该模块业务记录并提供查询',inputs:[],outputs:[],assumption:'虚构演示设计'});
  spec.relations.push({from:'platform',to:id,type:'contains',meaning:'平台业务模块',assumption:'虚构演示设计'});
}
let modelCalls=0;
const ctx={renderSvg,compareDiagramPpt,llm:async()=>{modelCalls++;return '{"passed":true,"issues":[]}';}};
const plan=JSON.parse(await createArchitecturePlanTool(ctx).run(spec,{rawRequestText:spec.requirements[0].text}));
assert.equal(plan.readyForRender,true);
const bundle=await loadArchitecture(plan.architecturePath);
const currentModel=layoutDiagram(projectArchitecture(bundle,{}));
const oldLayers=businessArchitectureLayout(bundle.plan,{view:'relations'}).layers;
const cardsModel=layoutDiagram(projectArchitecture(bundle,{layers:oldLayers,view:'overview'}));
assert.ok(currentModel.height<cardsModel.height,'密集总览应减少等大卡片带来的冗长画布');
await fs.writeFile(path.join(output,'density.json'),JSON.stringify({current:{width:currentModel.width,height:currentModel.height},allCards:{width:cardsModel.width,height:cardsModel.height}},null,2));
const result=await createDiagramTool(ctx,{requireArchitecture:true}).run({architecturePath:plan.architecturePath,path:'密集总体架构.svg',formats:['svg','png','pdf','pptx'],pptxMode:'editable'});
const receipt=JSON.parse(result.split('\n')[1]);
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));
assert.equal(receipt.editable.passed,true,JSON.stringify(receipt.editable));
assert.deepEqual(new Set(receipt.artifacts.map(item=>item.format)),new Set(['svg','png','pdf','pptx']));
assert.equal(new Set(receipt.artifacts.map(item=>item.designHash)).size,1);
const scene=JSON.parse(await workspace.readText(receipt.designPath));
const text=await workspace.readText(receipt.sourcePath);
assert.ok(text.includes('网格列名称'));
for(const entity of spec.entities.filter(item=>item.kind!=='system'))assert.ok(text.includes('id="node-'+entity.id+'"'),entity.id+'必须保留');
assert.equal(modelCalls,1);
for(const artifact of receipt.artifacts){const blob=await workspace.readBlob(artifact.path);assert.ok(blob.size>0);await fs.writeFile(path.join(output,path.basename(artifact.path)),new Uint8Array(await blob.arrayBuffer()));}
await fs.writeFile(path.join(output,'scene.json'),JSON.stringify(scene));
console.log('通过：三张主线卡片、八模块网格、能力/数据/基础设施/安全均实际绘出；真实四格式和原生PPT对照通过，非客户语义验收。');
