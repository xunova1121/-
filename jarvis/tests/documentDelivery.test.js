import {it,expect,beforeEach,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTools} from '../src/agent/tools.js';
import {createFileStore} from '../server/fileStore.mjs';
import {useBackend} from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
let dir;beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-delivery-'));useBackend(createFileStore(dir));});
afterEach(()=>{useBackend(null);fs.rmSync(dir,{recursive:true,force:true});});
it('结构验收后保存Office文件与同名PDF预览，明确视觉验收边界',async()=>{
 const files=[];const tool=createTools({onFileChanged:p=>files.push(p),officeRender:async()=>({available:true,blob:new Blob(['%PDF-test-preview'],{type:'application/pdf'})})}).find(t=>t.name==='create_document');
 const result=await tool.run({format:'docx',path:'文件/报告.docx',title:'报告',content:'# 报告\n\n## 核心结论\n本次交付先核对资料，再检查文件内容。'});
 expect(files).toEqual(['文件/报告.docx','文件/报告.预览.pdf','文件/文档检查/报告-docx.json']);expect(await ws.exists(files[0])).toBe(true);expect(await ws.exists(files[1])).toBe(true);
 expect(result).toContain('读回有效内容');expect(result).toContain('未宣称人工视觉验收通过');
});

it('没给标题时用文件名当封面标题，去掉“_5页”这种尾巴',async()=>{
 const tool=createTools({}).find(t=>t.name==='create_document');
 await tool.run({format:'pptx',path:'文件/仙逆剧情梳理_5页.pptx',content:'## 脱困\n- 王林炼化雷龙本源\n- 得到斩罗诀'});
 const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(await (await ws.readBlob('文件/仙逆剧情梳理_5页.pptx')).arrayBuffer());
 const cover=await zip.file('ppt/slides/slide1.xml').async('string');
 expect(cover).toContain('仙逆剧情梳理');expect(cover).not.toContain('5页');
});
