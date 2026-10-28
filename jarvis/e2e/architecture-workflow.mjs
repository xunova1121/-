/** 虚构材料：一次统一入口实际交付三视图四格式；仅模型回复为固定虚构内容，所有审查/渲染/导出真实执行。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {architectureSpec} from './fixtures/architecture-plan.mjs';
import {createArchitectureWorkflowTool} from '../src/agent/architectureWorkflow.js';
import {compareDiagramPpt} from '../server/diagramCompare.mjs';
import {renderSvg} from '../server/svgRender.mjs';
import * as ws from '../src/agent/workspace.js';
import {mediaReceipt} from '../src/agent/actionDelivery.js';
const spec=structuredClone(architectureSpec),names=new Map(spec.entities.map(e=>[e.id,e.title]));
const lines=[];const cite=text=>{lines.push(text);return {material:0,quote:text};};
const content={title:spec.title,entities:spec.entities.map(({assumption,source,excerpt,evidenceId,...e})=>({...e,citation:cite(e.title+'：'+e.responsibility+'。')})),relations:spec.relations.map(({assumption,source,excerpt,evidenceId,...r})=>({...r,citation:cite(names.get(r.from)+'→'+names.get(r.to)+'：'+r.meaning+'。')})),requirements:spec.requirements.map(r=>({entities:r.entities,citation:cite(r.text)}))};
await ws.write('虚构原文.md',lines.join('\n'));
let calls=0;const llm=async args=>{calls++;return args.system.includes('你负责业务理解')?JSON.stringify(content):'{"passed":true,"issues":[]}';};
const result=JSON.parse(await createArchitectureWorkflowTool({llm,renderSvg,compareDiagramPpt}).run({files:['虚构原文.md'],request:'制作总体架构及业务闭环和数据流，三视图四格式',directory:'交付/虚构统一流程',views:['overview','workflow','dataflow']}));
assert.equal(result.status,'complete');assert.equal(result.completedViews.length,3);assert.equal(calls,2);
assert.equal(mediaReceipt('build_architecture',true,JSON.stringify(result)).state,'completed');
const output=path.resolve(process.argv[2]||'/tmp/weiyang-architecture-workflow');await fs.mkdir(output,{recursive:true});
for(const view of result.completedViews){assert.equal(view.editable,true);assert.equal(view.files.length,5);assert.deepEqual(view.files.map(f=>f.format).sort(),['pdf','png','pptx','pptx','svg']);assert.equal(view.files.filter(f=>f.path.endsWith('-可编辑.pptx')).length,1);assert.equal(view.files.filter(f=>f.path.endsWith('-展示.pptx')).length,1);for(const file of view.files){const blob=await ws.readBlob(file.path);assert.ok(blob.size);await fs.writeFile(path.join(output,path.basename(file.path)),new Uint8Array(await blob.arrayBuffer()));}}
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(result,null,2));
const resumed=JSON.parse(await createArchitectureWorkflowTool({llm,renderSvg,compareDiagramPpt}).run({jobPath:result.jobPath}));
assert.equal(calls,2);assert.equal(resumed.status,'complete');assert.equal(resumed.reusedViews.length,3);
await ws.write('虚构原文.md','原件已更新');
await assert.rejects(createArchitectureWorkflowTool({llm,renderSvg,compareDiagramPpt}).run({jobPath:result.jobPath}),/原件已变化/);assert.equal(calls,2);
console.log('统一入口通过：2次合成模型回复，3视图15真实文件；完成后续接不新增模型调用，原件变化拒绝旧稿；原生PPT门槛保持，非真实模型理解验收。');
