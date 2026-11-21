import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDocumentNavigation} from '../src/agent/documentNavigation.js';
import {indexDocumentSections,resolveDocumentSection} from '../src/agent/documentSections.js';
import {createTools} from '../src/agent/tools.js';
import {generate} from '../src/agent/docs.js';
import {createFileStore} from '../server/fileStore.mjs';import {useBackend} from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import {loadArchitecture} from '../src/agent/architectureProjection.js';
import {diagramFailureDetails} from '../src/agent/diagramRecovery.js';
let folder;
beforeEach(()=>{folder=fs.mkdtempSync(path.join(os.tmpdir(),'document-navigation-'));useBackend(createFileStore(folder));});
afterEach(()=>{useBackend(null);fs.rmSync(folder,{recursive:true,force:true});});
it('实际DOCX可搜索并返回真实偏移，目录编号用于正文、证据、底稿和重开，未配置审查不能冒充通过',async()=>{
 const {blob}=await generate('docx',{title:'虚构采购',content:'# 第一章 采购需求\n\n## 一、建设内容\n\n配置数据服务，支撑研判处置。\n\n## 二、实施要求\n\n验收并培训。'});
 await ws.write('上传/虚构.docx',blob);
 const tools=createTools({}),call=(name,args)=>tools.find(tool=>tool.name===name).run(args).then(value=>{try{return JSON.parse(value);}catch{return value;}});
 const hits=await call('search_in_files',{path:'上传/虚构.docx',query:'配置数据服务'});
 expect(hits.scannedDocuments).toBe(1);expect(hits.matches[0].offset).toBeGreaterThan(0);
 expect(hits.matches[0].text).toContain('配置数据服务');
 const catalog=await call('read_file',{path:'上传/虚构.docx',view:'sections',query:'建设内容'});
 expect(catalog.sections).toHaveLength(1);
 const source={path:'上传/虚构.docx',sectionId:catalog.sections[0].sectionId};
 expect(await call('read_file',{...source})).toContain('配置数据服务');
 const receipt=await call('prepare_architecture_evidence',{sources:[source]});
 expect(receipt.readMaterials[0]).toMatchObject({truncated:false,sectionId:source.sectionId});
 const evidenceId=receipt.items[0].evidenceId;
 const result=await call('plan_architecture',{title:'虚构架构',sources:[source],entities:[{id:'data',title:'数据服务',kind:'capability',responsibility:'提供数据支撑',inputs:[],outputs:[],evidenceId}],relations:[],requirements:[{entities:['data'],evidenceId}]});
 expect(result.structure).toBe('passed');expect(result.semantic).toBe('not_checked');
 const saved=await loadArchitecture(result.architecturePath);expect(saved.plan.sources[0].sectionId).toBe(source.sectionId);
});
it('超过12万字的章节由程序切连续范围，完整parts无缺口；编号变化或伪造拒绝',async()=>{
 const doc={path:'合成.md',text:'第一章 采购需求\n'+('甲'.repeat(100)+'\n').repeat(1500)+'第二章 其他\n结尾'};
 const sections=await indexDocumentSections(doc),parts=sections.filter(item=>item.title==='第一章 采购需求');
 expect(parts.length).toBeGreaterThan(1);expect(parts.every(item=>item.chars<=60000)).toBe(true);
 for(let i=1;i<parts.length;i++)expect(parts[i].start).toBe(parts[i-1].end);
 expect(parts.map(item=>doc.text.slice(item.start,item.end)).join('')).toBe(doc.text.slice(0,doc.text.indexOf('第二章')));
 await expect(resolveDocumentSection({path:doc.path,text:doc.text+'变动'},parts[0].sectionId)).rejects.toHaveProperty('code','DOCUMENT_SECTION');
 await expect(resolveDocumentSection(doc,parts[0].sectionId.replace(/:\d+$/,':1'))).rejects.toHaveProperty('code','DOCUMENT_SECTION');
});
it('offset加1重叠页不重发正文、不错误标记新边界；文件改动后重新解析',async()=>{
 let blob=new Blob(['v1']);const parse=vi.fn(async()=>({text:'甲'.repeat(60000),chars:60000}));
 const nav=createDocumentNavigation({readBlob:async()=>blob,parse});
 const doc=await nav.read('x.docx'),segment=(text,offset)=>text.slice(offset,offset+20000);
 expect((await nav.page(doc,{offset:0},segment)).length).toBe(20000);
 const repeated=JSON.parse(await nav.page(await nav.read('x.docx'),{offset:1},segment));
 expect(repeated.state).toBe('already_read');expect(repeated.nextOffset).toBe(20000);expect(doc.ranges).toEqual([{start:0,end:20000}]);
 expect((await nav.page(doc,{offset:20000},segment)).length).toBe(20000);expect(parse).toHaveBeenCalledTimes(1);
 blob=new Blob(['v2']);expect((await nav.read('x.docx')).ranges).toEqual([]);expect(parse).toHaveBeenCalledTimes(2);
});
it('缓存有LRU和时效上限；停止信号不被缓存/目录读取吞掉',async()=>{
 let tick=0;const readBlob=vi.fn(async file=>new Blob([file]));const parse=vi.fn(async()=>({text:'真实正文',chars:4}));
 const nav=createDocumentNavigation({readBlob,parse,now:()=>tick});
 for(const file of ['a.docx','b.docx','c.docx','d.docx','a.docx'])await nav.read(file);
 expect(parse).toHaveBeenCalledTimes(5);tick=180001;await nav.read('a.docx');expect(parse).toHaveBeenCalledTimes(6);
 const ctrl=new AbortController();ctrl.abort();const count=readBlob.mock.calls.length;
 await expect(nav.read('a.docx',{signal:ctrl.signal})).rejects.toHaveProperty('name','AbortError');expect(readBlob).toHaveBeenCalledTimes(count);
});
it('关键词为字面原文，正则字符不扩张；Office错误与旧DOC不伪装为零命中',async()=>{
 const nav=createDocumentNavigation(),doc={path:'x',text:'a.b axb [ (x) x a+b aaab'};
 expect((await nav.search(doc,'a.b')).matches.map(item=>item.offset)).toEqual([0]);
 expect((await nav.search(doc,'[')).matches).toHaveLength(1);
 const search=createTools({}).find(tool=>tool.name==='search_in_files');
 await expect(search.run({path:'不存在.docx',query:'任意'})).rejects.toThrow();
 await expect(search.run({path:'旧原件.doc',query:'任意'})).rejects.toHaveProperty('code','DOCUMENT_NAVIGATION');
});
it('无效手填边界返回实际可引用编号，范围选项穿过错误格式化且不暴露正文',async()=>{
 await ws.write('长.md','第一章 采购需求\n真实建设。\n第二章 其他\n培训。');
 const tool=createTools({}).find(item=>item.name==='prepare_architecture_evidence');
 let error;try{await tool.run({sources:[{path:'长.md',sectionStart:'猜的标题'}]});}catch(e){error=e;}
 expect(error.code).toBe('ARCHITECTURE_SOURCE_SCOPE');const details=diagramFailureDetails(error);
 expect(details[0].scopeOptions.length).toBeGreaterThan(0);expect(JSON.stringify(details)).not.toContain('真实建设');
 const source=details[0].scopeOptions.find(item=>item.title.includes('采购需求')).source;
 const receipt=JSON.parse(await tool.run({sources:[source]}));expect(receipt.items.length).toBeGreaterThan(0);
});

it('短文正常复读保持兼容，防重复只针对长文分页',async()=>{
 const nav=createDocumentNavigation({readBlob:async()=>new Blob(['short']),parse:async()=>({text:'短正文',chars:3})});
 const doc=await nav.read('short.docx'),segment=text=>text;
 expect(await nav.page(doc,{},segment)).toBe('短正文');
 expect(await nav.page(doc,{},segment)).toBe('短正文');
});

it('旧工具原文过期时允许一次真实整页恢复，恢复也不能用offset加1无限重复',async()=>{
 const nav=createDocumentNavigation({readBlob:async()=>new Blob(['long']),parse:async()=>({text:'甲'.repeat(60000),chars:60000})});
 const doc=await nav.read('long.docx'),segment=(text,offset)=>text.slice(offset,offset+20000);
 await nav.page(doc,{},segment);
 expect(JSON.parse(await nav.page(doc,{},segment)).state).toBe('already_read');
 expect((await nav.page(doc,{recover:true},segment)).length).toBe(20000);
 expect(JSON.parse(await nav.page(doc,{offset:1,recover:true},segment)).state).toBe('already_read');
 expect(doc.recoveries).toEqual([{start:0,end:20000}]);
});

it('read_file严格Schema补空query时仍读章节正文；真实关键词与章节冲突仍拒绝',async()=>{
 await ws.write('空关键词.md','第一章 赛程\n赛事01，18:00，队伍1—队伍21。');
 const tool=createTools({}).find(item=>item.name==='read_file');
 const catalog=JSON.parse(await tool.run({path:'空关键词.md',view:'sections',query:''}));
 const sectionId=catalog.sections[0].sectionId;
 expect(await tool.run({path:'空关键词.md',view:'text',query:'',sectionId})).toContain('赛事01');
 await expect(tool.run({path:'空关键词.md',view:'text',query:'赛事01',sectionId})).rejects.toHaveProperty('code','DOCUMENT_NAVIGATION');
});
