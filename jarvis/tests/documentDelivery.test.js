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
 expect(files).toEqual(['文件/报告.docx','文件/报告.预览.pdf','文件/报告.docx.检查.json']);expect(await ws.exists(files[0])).toBe(true);expect(await ws.exists(files[1])).toBe(true);
 expect(result).toContain('读回有效内容');expect(result).toContain('未宣称人工视觉验收通过');
});

