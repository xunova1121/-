import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {prepareRuntime,validateRuntimeManifest} from './architecture-runtime-fetch.mjs';
const revision='a'.repeat(40);
const entry=(file,text)=>({path:file,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-fetch-'));const production=path.join(root,'production'),target=path.join(root,'test');await fs.mkdir(path.join(production,'src'),{recursive:true});return {root,production,target};}
test('仅下载缺失和改动文件，其他文件只读复用；固定版本和字节哈希逐项验证',async()=>{
 const f=await setup();try{
  await fs.writeFile(path.join(f.production,'src/a.js'),'same');await fs.writeFile(path.join(f.production,'src/b.js'),'old');
  const files=[entry('src/a.js','same'),entry('src/b.js','changed'),entry('server/c.mjs','new')];const urls=[];
  const result=await prepareRuntime({version:1,revision,files},f.production,f.target,{fetchFile:async(url,target)=>{urls.push(url);await fs.writeFile(target,url.endsWith('b.js')?'changed':'new');}});
  assert.deepEqual(result,{reused:1,downloaded:2,downloadedBytes:10});assert.ok(urls.every(url=>url.includes('/'+revision+'/jarvis/')));
  assert.equal(await fs.readFile(path.join(f.production,'src/b.js'),'utf8'),'old');
  assert.equal(await fs.readFile(path.join(f.target,'src/b.js'),'utf8'),'changed');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('中断后可复用已校验的测试文件，重跑准备代码不再次下载',async()=>{
 const f=await setup();try{
  const manifest={version:1,revision,files:[entry('src/a.js','new')]};
  await prepareRuntime(manifest,f.production,f.target,{fetchFile:async(url,target)=>fs.writeFile(target,'new')});
  const result=await prepareRuntime(manifest,f.production,f.target,{fetchFile:()=>{throw new Error('不能重复下载');}});
  assert.deepEqual(result,{reused:1,downloaded:0,downloadedBytes:0});
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('错误下载不能变为正式测试代码，生产文件不被覆盖',async()=>{
 const f=await setup();try{
  await assert.rejects(prepareRuntime({version:1,revision,files:[entry('src/a.js','correct')]},f.production,f.target,{fetchFile:async(url,target)=>fs.writeFile(target,'wrong')}),{code:'ARCHITECTURE_RUNTIME_HASH'});
  await assert.rejects(fs.stat(path.join(f.target,'src/a.js')),{code:'ENOENT'});
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('越界路径、重复路径和超容量清单拒绝，不写生产目录',async()=>{
 const valid={version:1,revision,files:[entry('src/a.js','x')]};
 for(const files of [[entry('../config.json','x')],[entry('src/../config.json','x')],[...valid.files,...valid.files],[{...valid.files[0],bytes:21e6}]])assert.throws(()=>validateRuntimeManifest({...valid,files}),{code:'ARCHITECTURE_RUNTIME_MANIFEST'});
 const f=await setup();try{await assert.rejects(prepareRuntime(valid,f.production,f.production),{code:'ARCHITECTURE_RUNTIME_MANIFEST'});}finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('已有结果目录在联网或提交任务前拒绝重复执行',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const root=await fs.mkdtemp('/tmp/weiyang-architecture-code-guard-');
 try{
  await fs.mkdir(path.join(root,'results'));
  await assert.rejects(promisify(execFile)('bash',['evals/run-architecture-server.sh'],{env:{...process.env,JARVIS_ARCHITECTURE_CODE_DIR:root}}),error=>error.code===1&&error.stderr.includes('已有测试结果'));
  assert.deepEqual(await fs.readdir(root),['results']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
