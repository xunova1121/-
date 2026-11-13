import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {architectureServerInput} from './architecture-server-input.mjs';
const source='上传/虚构采购.docx';
async function fixture(){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'architecture-live-input-'));
 const files=path.join(folder,'store','files');await fs.mkdir(files,{recursive:true});
 const hash=createHash('sha1').update(source).digest('hex');
 const cfg={provider:'deepseek',models:{deepseek:'test-current-model'},keys:{deepseek:'TEST-SECRET-DO-NOT-PRINT'},routing:{enabled:true}};
 const config=JSON.stringify(cfg);await fs.writeFile(path.join(folder,'config.json'),config);
 const record=JSON.stringify({id:source,data:{$file:hash+'.data.bin'}});
 await fs.writeFile(path.join(files,hash+'.json'),record);await fs.writeFile(path.join(files,hash+'.data.bin'),Buffer.from([0x50,0x4b,3,4]));
 return {folder,files,hash,config,record};
}
test('只读确切原件和当前配置，不改模型分工，不把Key放入结果摘要',async()=>{
 const f=await fixture();try{
  const result=await architectureServerInput(f.folder,source);
  assert.equal(result.bytes.length,4);assert.equal(result.cfg.routing.enabled,true);
  assert.deepEqual(result.selected,{provider:'deepseek',model:'test-current-model',routingEnabled:true});
  assert.ok(!JSON.stringify(result.selected).includes('TEST-SECRET'));
  assert.equal(await fs.readFile(path.join(f.folder,'config.json'),'utf8'),f.config);
  assert.equal(await fs.readFile(path.join(f.files,f.hash+'.json'),'utf8'),f.record);
  assert.deepEqual((await fs.readdir(f.folder)).sort(),['config.json','store']);
 }finally{await fs.rm(f.folder,{recursive:true,force:true});}
});
test('错路径、不匹配记录和越界二进制拒绝，不读取其他对话替代原件',async()=>{
 const f=await fixture();try{
  await assert.rejects(architectureServerInput(f.folder,'上传/不存在.docx'));
  await fs.writeFile(path.join(f.files,f.hash+'.json'),JSON.stringify({id:source,data:{$file:'../elsewhere.bin'}}));
  await assert.rejects(architectureServerInput(f.folder,source),{code:'ARCHITECTURE_TEST_INPUT'});
  await fs.writeFile(path.join(f.files,f.hash+'.json'),f.record);
  await fs.unlink(path.join(f.files,f.hash+'.data.bin'));
  await fs.writeFile(path.join(f.folder,'outside.bin'),Buffer.from([0x50,0x4b,3,4]));
  await fs.symlink(path.join(f.folder,'outside.bin'),path.join(f.files,f.hash+'.data.bin'));
  await assert.rejects(architectureServerInput(f.folder,source),{code:'ARCHITECTURE_TEST_INPUT'});
 }finally{await fs.rm(f.folder,{recursive:true,force:true});}
});
test('未显式live时不读生产配置，不发真实模型请求',async()=>{
 const {NODE_TEST_CONTEXT: _context,...childEnv}=process.env;
 const {stdout}=await promisify(execFile)(process.execPath,['evals/architecture-server.mjs'],{env:childEnv});
 assert.match(stdout,/仅说明/);
});
