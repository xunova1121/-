import {architectureReferences} from '../src/agent/architectureReferences.js';
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
const reviewRecovery=process.argv[3]==='review-recovery';
const repair=process.argv[3]==='json-repair', correction=process.argv[3]==='content-repair', alias=correction||process.argv[3]==='objects', indexed=repair||alias||reviewRecovery||process.argv[3]==='references';
const sourceText=(indexed?lines.map(line=>line.padEnd(480,' ')):lines).join('\n');
await ws.write('虚构原文.md',sourceText);
if(indexed){const refs=architectureReferences([{path:'虚构原文.md',text:sourceText}])[0];for(const group of ['entities','relations','requirements'])for(const item of content[group]){const block=refs.blocks.find(block=>block.text.includes(item.citation.quote));assert.ok(block,'真实引用块须完整包含对应原文');item.citation={material:0,block:block.block};}}
let calls=0, contentCalls=0, reviewCalls=0;const llm=async args=>{calls++;if(repair&&calls===1)return {text:JSON.stringify(content).replace(',"entities"',' "entities"'),stop:'end_turn'};
if(args.system.includes('你负责业务理解')){contentCalls++;
 assert.ok(args.system.includes('根键固定为title/entities/relations/requirements'));
 if(correction&&calls===2){const context=JSON.parse(args.prompt);assert.ok(context.completeDiagnostics.diagnostics.some(d=>d.field==='relations[0].to'));return JSON.stringify({corrections:[{group:'relations',index:0,value:content.relations[0]}]});}
 if(alias){const {entities,...rest}=structuredClone(content);if(correction)rest.relations[0].to=rest.relations[0].from;return JSON.stringify({...rest,objects:entities});}
 return JSON.stringify(content);
}
if(reviewRecovery&&!args.system.includes('只修复给定JSON')){reviewCalls++;if(reviewCalls===1)return {text:'{"passed":false,"issues":[{"target":"plan","kind":"flow/coverage","detail":"虚构的格式失败注入"}]}',stop:'end_turn'};}
return args.system.includes('只修复给定JSON')?JSON.stringify(content):'{"passed":true,"issues":[]}';};
const tool=createArchitectureWorkflowTool({llm,renderSvg,compareDiagramPpt});
const startArgs={files:['虚构原文.md'],request:'制作总体架构及业务闭环和数据流，三视图四格式',directory:'交付/虚构统一流程',views:['overview','workflow','dataflow']};
let runArgs=startArgs;
if(repair||correction){await assert.rejects(tool.run(startArgs),{code:repair?'ARCHITECTURE_CONTENT_FORMAT':'ARCHITECTURE_PLAN'});const state=(await ws.list('文档检查/架构任务')).find(f=>!f.path.includes('.content.'));runArgs={jobPath:state.path};}
let result=JSON.parse(await tool.run(reviewRecovery?{...runArgs,directory:startArgs.directory+'/'}:runArgs));
if(reviewRecovery){assert.equal(result.stage,'review');assert.equal(result.ready,false);const state=JSON.parse(await ws.readText(result.jobPath));const contentBefore=await ws.readText(state.contentPath),planBefore=await ws.readText(state.architecturePath);result=JSON.parse(await tool.run({jobPath:result.jobPath}));assert.equal((JSON.parse(await ws.readText(result.jobPath))).attempts,1);assert.equal(contentCalls,1);assert.equal(reviewCalls,2);assert.equal(await ws.readText(state.contentPath),contentBefore);assert.equal(await ws.readText(state.architecturePath),planBefore);}
const expectedCalls=repair||correction||reviewRecovery?3:2;
assert.equal(result.status,'complete');assert.equal(result.completedViews.length,3);assert.equal(calls,expectedCalls);
assert.equal(mediaReceipt('build_architecture',true,JSON.stringify(result)).state,'completed');
const output=path.resolve(process.argv[2]||'/tmp/weiyang-architecture-workflow');await fs.mkdir(output,{recursive:true});
for(const view of result.completedViews){assert.equal(view.editable,true);assert.equal(view.files.length,5);assert.deepEqual(view.files.map(f=>f.format).sort(),['pdf','png','pptx','pptx','svg']);assert.equal(view.files.filter(f=>f.path.endsWith('-可编辑.pptx')).length,1);assert.equal(view.files.filter(f=>f.path.endsWith('-展示.pptx')).length,1);for(const file of view.files){const blob=await ws.readBlob(file.path);assert.ok(blob.size);await fs.writeFile(path.join(output,path.basename(file.path)),new Uint8Array(await blob.arrayBuffer()));}}
await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(result,null,2));
const resumed=JSON.parse(await createArchitectureWorkflowTool({llm,renderSvg,compareDiagramPpt}).run({jobPath:result.jobPath}));
assert.equal(calls,expectedCalls);assert.equal(resumed.status,'complete');assert.equal(resumed.reusedViews.length,3);
await ws.write('虚构原文.md','原件已更新');
await assert.rejects(createArchitectureWorkflowTool({llm,renderSvg,compareDiagramPpt}).run({jobPath:result.jobPath}),/原件已变化/);assert.equal(calls,expectedCalls);
console.log(`统一入口通过：${expectedCalls}次合成模型回复，3视图15真实文件；完成后续接不新增模型调用，原件变化拒绝旧稿；原生PPT门槛保持，非真实模型理解验收。`);
