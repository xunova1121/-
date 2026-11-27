import {beforeEach,afterEach,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFileStore} from '../server/fileStore.mjs';
import {useBackend} from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import {createDocumentGenerateTool} from '../src/agent/documentGenerateTool.js';
import {createDocumentEditingTools} from '../src/agent/documentEditingTools.js';
import {assertArchitectureToolCall} from '../src/agent/architectureStateProtection.js';
import {simpleDocumentTask} from '../src/agent/documentToolProfile.js';
let dir;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'docpath-'));useBackend(createFileStore(dir));});
afterEach(()=>{useBackend(null);fs.rmSync(dir,{recursive:true,force:true});});
it('缺省路径真正生成Word/PPT且重名不覆盖',async()=>{
  for(const format of ['docx','pptx']) {
    const tool=createDocumentGenerateTool({});
    const args={format,title:'赛程',content:'# 赛程\n\n## 明细\n甲队对乙队，18:00开赛。'};
    await assertArchitectureToolCall('create_document',{...args,path:''});
    await tool.run(args);
    const before=await ws.readBlob(`outputs/赛程.${format}`);
    await tool.run(args);
    expect(await ws.exists(`outputs/赛程-2.${format}`)).toBe(true);
    expect(await (await ws.readBlob(`outputs/赛程.${format}`)).arrayBuffer()).toEqual(await before.arrayBuffer());
  }
});
it('受管文件仍拦截，缺原路径编辑给清楚提示',async()=>{
  await expect(assertArchitectureToolCall('create_document',{path:'文档检查/架构底稿/test.json'})).rejects.toMatchObject({code:'ARCHITECTURE_STATE_PROTECTED'});
  await expect(createDocumentEditingTools({})[0].run({replacements:[]})).rejects.toMatchObject({code:'DOCUMENT_SOURCE_PATH'});
});
it('简单整理轻量，研究方案不误降级',()=>{
  expect(simpleDocumentTask('把上面赛程整理成一份清爽Word')).toBe(true);
  expect(simpleDocumentTask('再做一份PPT')).toBe(true);
  expect(simpleDocumentTask('把上述内容调研后做一份完整方案Word')).toBe(false);
});
