import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';import { diagramDigest } from '../src/agent/diagramExport.js';
import { reusableArchitectureViews } from '../src/agent/architecturePackageState.js';
let folder;
beforeEach(()=>{folder=fs.mkdtempSync(path.join(os.tmpdir(),'package-reuse-'));useBackend(createFileStore(folder));});
afterEach(()=>{useBackend(null);fs.rmSync(folder,{recursive:true,force:true});});
const bundle={path:'稿.architecture.json',planHash:'same-plan',report:{structure:'passed',semantic:'passed'}};
async function setup(){
 const files=[];
 for(const format of ['svg','png','pdf','pptx']){
  const target='交付/视图'+(format==='pptx'?'-可编辑':'')+'.'+format;
  const data=new Blob(['真实文件:'+format]);await ws.write(target,data);
  files.push({path:target,format,hash:await diagramDigest(data)});
 }
 const value={version:1,architecturePath:bundle.path,planHash:bundle.planHash,completedViews:[{view:'overview',editable:true,designHash:'design',files}]};
 await ws.write('交付/交付清单.json',JSON.stringify(value));return value;
}
it('同底稿且实际文件哈希一致才复用，文件被改只使该视图失效',async()=>{
 const value=await setup();
 expect((await reusableArchitectureViews('交付/交付清单.json',bundle,['overview'],'交付')).map(item=>item.view)).toEqual(['overview']);
 await ws.write(value.completedViews[0].files[0].path,'改过的文件');
 expect(await reusableArchitectureViews('交付/交付清单.json',bundle,['overview'],'交付')).toEqual([]);
});
it('不同版本拒绝覆盖，当前业务审查失败不能凭旧清单通过，停止原样上抛',async()=>{
 await setup();
 await expect(reusableArchitectureViews('交付/交付清单.json',{...bundle,planHash:'other'},['overview'],'交付')).rejects.toHaveProperty('code','ARCHITECTURE_PACKAGE_STATE');
 expect(await reusableArchitectureViews('交付/交付清单.json',{...bundle,report:{structure:'passed',semantic:'failed'}},['overview'],'交付')).toEqual([]);
 const ctrl=new AbortController();ctrl.abort();
 await expect(reusableArchitectureViews('交付/交付清单.json',bundle,['overview'],'交付',ctrl.signal)).rejects.toHaveProperty('name','AbortError');
});
it('无效清单不覆盖，目录外文件不能当成已核对成果',async()=>{
 const value=await setup();value.completedViews[0].files[0].path='别处/文件.svg';
 await ws.write('交付/交付清单.json',JSON.stringify(value));
 expect(await reusableArchitectureViews('交付/交付清单.json',bundle,['overview'],'交付')).toEqual([]);
 await ws.write('交付/交付清单.json','broken');
 await expect(reusableArchitectureViews('交付/交付清单.json',bundle,['overview'],'交付')).rejects.toHaveProperty('code','ARCHITECTURE_PACKAGE_STATE');
});
