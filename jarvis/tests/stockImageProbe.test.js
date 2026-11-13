import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for(const [name,mock,expected] of [
 ['HTML拦截页', `async()=>new Response('<html>private-secret-do-not-print</html>',{headers:{'content-type':'text/html'}})`, {phase:'api',httpStatus:200,contentType:'text/html'}],
 ['HTTP拒绝', `async()=>new Response('private-secret-do-not-print',{status:403,headers:{'content-type':'text/html'}})`, {phase:'api',httpStatus:403,reason:'HTTP 403'}],
 ['DNS失败', `async()=>{throw new TypeError('private-secret-do-not-print',{cause:{code:'ENOTFOUND'}})}`, {phase:'api',errorCode:'ENOTFOUND'}]
])test(`独立国内探测区分${name}，不回显响应体或凭据`,()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-probe-test-'));
 try{
  const setup='data:text/javascript;base64,'+Buffer.from('globalThis.fetch='+mock).toString('base64');
  let result;
  try{execFileSync(process.execPath,['--import',setup,'evals/stock-images-live.mjs','--network=cn','--config='+path.join(dir,'absent.json')],{encoding:'utf8',env:{...process.env,TMPDIR:dir}});throw new Error('失败探测不能返回成功');}
  catch(error){expect(error.status).toBe(1);expect(error.stderr).toBe('');result=error.stdout;}
  expect(result).not.toContain('private-secret-do-not-print');
  const report=JSON.parse(result.slice(0,result.indexOf('\n报告目录：')));
  expect(report).toMatchObject({state:'failed',modelRequested:false,productionChanged:false,...expected});
  if(name==='HTML拦截页')expect(report.reason).toContain('未返回合法JSON');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
