import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {architectureServerAcceptance} from './architecture-server-acceptance.mjs';
import {assertArchitectureRevision,architectureServerReadiness} from './architecture-server-readiness.mjs';
import {architectureServerExitCode} from './architecture-server.mjs';
import {diagramDigest} from '../src/agent/diagramExport.js';
import {layoutDiagram} from '../src/agent/diagramModel.js';
import {diagramScene} from '../src/agent/diagramScene.js';
import {sceneSvg} from '../src/agent/diagramSceneSvg.js';
import {makeDiagramPptx} from '../src/agent/diagramPptx.js';
const views=['overview','workflow','dataflow'];
const json=value=>new Blob([JSON.stringify(value)]);
const directory='evals/synthetic-acceptance';
async function fixture(){
 const files=new Map();
 const plan={version:1,entities:[{id:'a'}],materialHashes:[{path:'虚构原文.md',hash:'sha256:'+'a'.repeat(64)}]};
 const planHash=await diagramDigest(JSON.stringify(plan)),architecturePath='文档检查/架构底稿/synthetic.architecture.json';
 const bundle={plan,planHash,report:{structure:'passed',semantic:'passed',planHash},sourceChecks:[{matched:true,truncated:false,scope:'file'}]};
 const manifest={version:1,status:'complete',architecturePath,planHash,selectedViews:views,completedViews:[],files:[]};
 const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')],{type:'image/png'});
 for(const view of views){
  const base=directory+'/'+view;
  const scene=diagramScene(layoutDiagram({title:'虚构验收',layers:[{title:'感知',nodes:[{id:'a',title:'采集'}]},{title:'业务',nodes:[{id:'b',title:'办理'}]}],edges:[{from:'a',to:'b'}]}));
  scene.architecture={planPath:architecturePath,planHash,semantic:'passed',structure:'passed',view,draft:false};
  const designHash=await diagramDigest(JSON.stringify(scene));
  const data=[
   [base+'.svg',new Blob([sceneSvg(scene)]),'svg','shared_design'],
   [base+'-预览.png',png,'png','shared_render'],
   [base+'.pdf',new Blob(['%PDF-1.4\n% synthetic mocked receipt fixture']),'pdf','shared_render'],
   [base+'-展示.pptx',await makeDiagramPptx(scene,{png}),'pptx','shared_render'],
   [base+'-可编辑.pptx',await makeDiagramPptx(scene,{editable:true}),'pptx','render_compared']
  ];
  const artifacts=[];
  for(const [target,blob,format,consistency]of data){files.set(target,blob);artifacts.push({path:target,format,hash:await diagramDigest(blob),designHash,consistency,...(format==='pptx'&&{editability:consistency==='render_compared'?'editable':'display'})});}
  const exports={version:1,designHash,designPath:base+'.diagram.json',sourcePath:base+'.svg',previewHash:await diagramDigest(png),primaryEditablePath:base+'-可编辑.pptx',errors:[],artifacts,editable:{passed:true,state:'render_compared',meanChannelError:0.001,aspectError:0}};
  files.set(base+'.diagram.json',json(scene));files.set(base+'.exports.json',json(exports));
  manifest.completedViews.push({view,designHash,editable:true,previewPath:base+'-预览.png',files:artifacts.map(({path,format,hash})=>({path,format,hash}))});
  manifest.files.push(...artifacts.map(item=>item.path));
 }
 files.set(directory+'/交付清单.json',json(manifest));
 const readBlob=async target=>{if(!files.has(target))throw Object.assign(new Error('missing'),{code:'ENOENT'});return files.get(target);};
 return{files,bundle,manifest,readBlob,accept:()=>architectureServerAcceptance(directory,{readBlob,loadPlan:async()=>bundle})};
}
async function updateJson(f,target,change){const value=JSON.parse(await f.files.get(target).text());change(value);f.files.set(target,json(value));}

test('任务done不算交付：CLI需实际三视图验收且结果文件已导出，客户质量保持未复核',async()=>{
 assert.equal(architectureServerExitCode(),0);
 assert.equal(architectureServerExitCode({report:{status:'done',delivery:{state:'failed'},deliveryExported:false}}),2);
 assert.equal(architectureServerExitCode({report:{status:'done',delivery:{state:'complete'},deliveryExported:false}}),2);
 assert.equal(architectureServerExitCode({report:{status:'done',delivery:{state:'complete'},deliveryExported:true}}),0);
 const result=await architectureServerAcceptance(directory,{readBlob:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});}});
 assert.equal(result.state,'failed');assert.equal(result.customerVisual,'not_reviewed');
});
test('虚构编排收据+真实原生PPT结构：三视图同稿哈希齐全后只判文件完成，不假称客户验收',async()=>{
 const f=await fixture(),result=await f.accept();
 assert.equal(result.state,'complete',JSON.stringify(result));assert.equal(result.views.length,3);
 assert.equal(result.views.reduce((sum,view)=>sum+view.files.length,0),15);
 assert.equal(result.modelBusinessReview,'passed');assert.equal(result.customerBusiness,'not_reviewed');assert.equal(result.customerVisual,'not_reviewed');
 assert.ok(result.views.every(view=>view.nativeStructure.nodeGroups>=2&&view.nativeStructure.textBoxes>0&&view.nativeStructure.anchoredEnds===6&&view.nativeStructure.connectors===3),JSON.stringify(result.views.map(view=>view.nativeStructure)));
});
test('部分包、缺专题、业务未审或材料截断均不接受',async()=>{
 for(const change of [
  f=>{f.manifest.status='partial';},
  f=>{f.manifest.completedViews.pop();},
  f=>{f.bundle.report.semantic='not_checked';},
  f=>{f.bundle.sourceChecks[0].truncated=true;},
  f=>{f.bundle.report.planHash='sha256:'+'b'.repeat(64);}
 ]){const f=await fixture();change(f);f.files.set(directory+'/交付清单.json',json(f.manifest));assert.notEqual((await f.accept()).state,'complete');}
});
test('文件替换、跨目录、旧清单及不同scene版本拒绝',async()=>{
 for(const change of [
  f=>f.files.set(directory+'/overview-预览.png',new Blob(['changed'])),
  f=>{f.manifest.completedViews[0].files[0].path='../outside.svg';},
  f=>{f.manifest.files.push('旧稿.svg');},
  async f=>updateJson(f,directory+'/overview.diagram.json',scene=>{scene.title='changed';})
 ]){const f=await fixture();await change(f);f.files.set(directory+'/交付清单.json',json(f.manifest));assert.notEqual((await f.accept()).state,'complete');}
});
test('不放宽原PPT像素差/宽高比；图片展示PPT不能改名冒充可编辑',async()=>{
 for(const [field,value]of [['meanChannelError',0.012001],['aspectError',0.01],['passed',false],['state','not_checked']]){
  const f=await fixture();await updateJson(f,directory+'/overview.exports.json',record=>{record.editable[field]=value;});assert.equal((await f.accept()).failure.code,'ARCHITECTURE_ACCEPTANCE_COMPARE');
 }
 const f=await fixture(),view=f.manifest.completedViews[0],native=view.files.find(file=>file.path.endsWith('-可编辑.pptx'));
 const display=f.files.get(directory+'/overview-展示.pptx');f.files.set(native.path,display);native.hash=await diagramDigest(display);
 await updateJson(f,directory+'/overview.exports.json',record=>{record.artifacts.find(file=>file.path===native.path).hash=native.hash;});
 f.files.set(directory+'/交付清单.json',json(f.manifest));assert.equal((await f.accept()).failure.code,'ARCHITECTURE_ACCEPTANCE_STRUCTURE');
});
test('版本不匹配先拒绝；依赖检测不等于实际渲染，SVG备用不可用不误拦Office路径',async()=>{
 const a='a'.repeat(40),b='b'.repeat(40);assert.doesNotThrow(()=>assertArchitectureRevision(a,a));assert.throws(()=>assertArchitectureRevision(b,a),{code:'ARCHITECTURE_TEST_REVISION'});
 const supported=await architectureServerReadiness({office:async()=>true,probe:async binary=>binary==='pdftoppm'});
 assert.equal(supported.state,'dependencies_detected');assert.equal(supported.rendering,'not_exercised');
 const unsupported=await architectureServerReadiness({office:async()=>false,probe:async()=>true});assert.equal(unsupported.state,'blocked');
});
test('只安装Cairo也支持同一Office对照；两种栅格器都缺少仍阻止实测',async()=>{
 const cairo=await architectureServerReadiness({office:async()=>true,probe:async binary=>binary==='pdftocairo'});
 assert.equal(cairo.state,'dependencies_detected');assert.equal(cairo.pdfRaster,true);assert.deepEqual(cairo.pdfRasterEngines,{pdftocairo:true,pdftoppm:false});
 const neither=await architectureServerReadiness({office:async()=>true,probe:async()=>false});assert.equal(neither.state,'blocked');assert.equal(neither.pdfRaster,false);
});
test('引导脚本清单禁缓存且指定旧版本在读取生产配置/安装依赖/模型请求前拒绝',async()=>{
 const root=await fs.mkdtemp('/tmp/weiyang-architecture-code-pin-');
 try{
  const bin=path.join(root,'bin');await fs.mkdir(bin);const trace=path.join(root,'trace.txt');
  await fs.writeFile(path.join(bin,'curl'),'#!/usr/bin/env bash\nset -eu\nprevious=""\ntarget=""\nfor item in "$@"; do\n if [ "$previous" = "-o" ]; then target="$item"; fi\n previous="$item"\ndone\nprintf \'%s\\n\' "$*" >> "$ARCHITECTURE_CHECK_TRACE"\nprintf \'%s\' \'{"version":1,"revision":"'+('b'.repeat(40))+'","files":[]}\' > "$target"\n',{mode:0o700});
  const {NODE_TEST_CONTEXT:_test,...env}=process.env;
  await assert.rejects(promisify(execFile)('bash',['evals/run-architecture-server.sh'],{env:{...env,PATH:bin+path.delimiter+env.PATH,JARVIS_ARCHITECTURE_CODE_DIR:root,JARVIS_ARCHITECTURE_EXPECTED_REVISION:'a'.repeat(40),ARCHITECTURE_CHECK_TRACE:trace}}),error=>error.code===1&&error.stderr.includes('测试清单不是指定提交'));
  const calls=await fs.readFile(trace,'utf8');assert.match(calls,/Cache-Control: no-cache/);assert.match(calls,/manifest\.json\?v=/);assert.equal(calls.trim().split('\n').length,1);
  assert.equal((await fs.readdir(root)).includes('source'),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
