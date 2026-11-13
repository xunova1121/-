/** 虚构材料三步：Word→PPT→逐页自有图。真实Office渲染，不调用模型/API；不能冒充线上模型耗时验收。 */
import fs from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')+'/';
const imp=p=>import(pathToFileURL(base+p));
const {useBackend}=await imp('src/agent/store.js');const {createFileStore}=await imp('server/fileStore.mjs');
const {createDocumentGenerateTool}=await imp('src/agent/documentGenerateTool.js');
const {renderOffice}=await imp('server/officeRender.mjs');const {presentationOverview}=await imp('server/presentationOverview.mjs');const {renderSvg}=await imp('server/svgRender.mjs');
const ws=await imp('src/agent/workspace.js');const folder=process.argv[2]||await fs.mkdtemp(path.join(os.tmpdir(),'weiyang-ppt-delivery-'));await fs.mkdir(folder,{recursive:true});useBackend(createFileStore(folder+'/data'));
const fixture=await renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="#164A5B"/><rect x="100" y="100" width="800" height="600" rx="10" fill="none" stroke="#A9D8C8" stroke-width="5"/><path d="M500 100V700" stroke="#A9D8C8" stroke-width="5"/><circle cx="500" cy="400" r="90" fill="none" stroke="#A9D8C8" stroke-width="5"/></svg>');
await ws.write('uploads/虚构球场.png',fixture);
const table='| 开赛时间 | 对阵 | 状态 |\n|---|---|---|\n'+Array.from({length:20},(_,i)=>`| ${18+Math.floor(i/8)}:${i%2?'30':'00'} | 队伍${i+1}—队伍${i+21} | 未开赛 |`).join('\n');
const tool=createDocumentGenerateTool({officeRender:renderOffice,presentationOverview,renderSvg,documentStylePreferences:async()=>'',onFileChanged:()=>{}});
const content='## 赛事概况\n- 20场未开赛\n- 40支参赛队伍\n\n## 赛程\n版式：表格\n\n'+table+'\n\n## 来源\n本文件仅使用虚构测试数据。\n\n## 口径\n按开赛时间统计；不代表真实比赛。';
const outputs=[];
for(const [format,image]of [['docx',false],['pptx',false],['pptx',true]]){
 const started=Date.now();const text=image?content.replace(/(^## [^\n]+\n)/gm,'$1\n![自有测试图](uploads/虚构球场.png)\n') : content;
 const input={format,title:'虚构赛事安排',path:`outputs/${format}${image?'-每页图':''}.${format}`,content:text,requirements:format==='docx'?'整理Word，不要横线':image?'做PPT，每页都有图，只用上传图片':'做清爽PPT，保留完整20条赛程'};
 // cover supplied by same explicit user fixture; no paid API, no fake generated images
 if(image)input.content='# 虚构赛事安排\n![自有测试图](uploads/虚构球场.png)\n\n'+text;
 const answer=await tool.run(input,{signal:AbortSignal.timeout(180000)});
 const blob=await ws.readBlob(input.path);await fs.writeFile(folder+'/'+input.path.split('/').at(-1),new Uint8Array(await blob.arrayBuffer()));
 outputs.push({format,image,elapsedMs:Date.now()-started,answer});console.log(format,image,Date.now()-started);
}
await fs.writeFile(folder+'/receipts.json',JSON.stringify(outputs,null,2));
for(const file of await ws.list('outputs')){
 if(/总览.*\.png$|预览\.pdf$/.test(file.path)){const blob=await ws.readBlob(file.path);await fs.writeFile(folder+'/'+file.path.split('/').at(-1),new Uint8Array(await blob.arrayBuffer()));}
}
console.log(folder);
