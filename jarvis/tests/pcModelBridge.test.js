import {it,expect,beforeAll,afterAll,beforeEach,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../server/server.mjs';
import {createServerMode,tokenFor} from '../server/serverMode.mjs';
import {bridgeInput} from '../server/pcModelBridge.mjs';
import {createServerClient} from '../src/core/serverClient.js';
import {createPCModelAdapter} from '../src/core/pcModelClient.js';
import {useBackend} from '../src/agent/store.js';

let dir,mode,http,base,client,behavior,seen=[];
const pass='test-pc-password',secret='FAKE_KEY_NOT_REAL_123456';
const cfg={provider:'custom',models:{custom:'primary'},keys:{custom:secret},routing:{enabled:true,provider:'custom',routes:{chat:'primary',code:'backup',vision:'vision-model'}}};
const req=()=>({model:'ignored',system:['test'],messages:[{role:'user',content:'点击窗口'}],tools:[{name:'computer_look',description:'screen',input_schema:{type:'object',properties:{}}}],stallTimeouts:{first:5000,between:5000},onText:()=>{}});
beforeAll(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-pc-model-'));
  mode=createServerMode({dataDir:dir,password:pass,makeModelAdapter:c=>({model:c.models[c.provider],adapter:{stream:async o=>{seen.push(o);return behavior(o);}}})});
  http=createServer({serverMode:mode,ollama:null});await new Promise(r=>http.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${http.address().port}`;
  client=createServerClient({base,token:tokenFor(pass)});
});
beforeEach(async()=>{seen=[];await client.putConfig(cfg);behavior=async o=>{o.onText('回答');return{text:'回答',toolCalls:[],stop:'end_turn'};};});
afterAll(async()=>{await mode.runner.settled();http.closeAllConnections();await new Promise(r=>http.close(r));useBackend(null);fs.rmSync(dir,{recursive:true,force:true});});
it('真实HTTP桥使用服务器配置、看图路由与认证；密钥不进入客户端请求/响应',async()=>{
  const text=[],models=[];const adapter=createPCModelAdapter(client,{task:'vision',onModel:m=>models.push(m)});
  const result=await adapter.stream({...req(),onText:d=>text.push(d)});
  expect(result.text).toBe('回答');expect(text.join('')).toBe('回答');expect(models).toEqual(['vision-model']);expect(seen[0].model).toBe('vision-model');
  expect(JSON.stringify(result)).not.toContain(secret);expect(seen[0]).not.toHaveProperty('baseURL');
  const unauthorized=await fetch(`${base}/api/server/pc-model`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req())});expect(unauthorized.status).toBe(401);
});
it('桥只返回工具调用，不在服务器执行电脑命令；原生raw协议保留',async()=>{
  behavior=async()=>({text:'',toolCalls:[{id:'c',name:'computer_open',args:{target:'报告.xlsx'}}],stop:'tool_use',raw:{protocol:'original'}});
  const result=await createPCModelAdapter(client).stream(req());expect(result.toolCalls[0].name).toBe('computer_open');expect(result.raw).toEqual({protocol:'original'});expect(mode.runner.list()).toEqual([]);
});
it('主模型失败可回退，已经输出半截则不切换；错误隐藏服务器密钥',async()=>{
  const models=[];behavior=async o=>{if(o.model==='primary')throw Object.assign(Error('temporary'),{status:503});o.onText('backup');return{text:'backup',toolCalls:[],stop:'end_turn'};};
  expect((await createPCModelAdapter(client,{onModel:m=>models.push(m)}).stream(req())).text).toBe('backup');expect(models).toEqual(['primary','backup']);
  seen=[];behavior=async o=>{o.onText('half');throw Object.assign(Error(`failed ${secret}`),{status:503});};
  await expect(createPCModelAdapter(client).stream(req())).rejects.toThrow('[已隐藏]');expect(seen).toHaveLength(1);
});
it('取消关闭在途模型请求；超过并发上限不会再调用模型',async()=>{
  let aborted=0;behavior=o=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>{aborted++;reject(Object.assign(Error('aborted'),{name:'AbortError'}));},{once:true});});
  const a=new AbortController(),b=new AbortController();
  const p1=createPCModelAdapter(client).stream({...req(),signal:a.signal}).catch(e=>e);
  const p2=createPCModelAdapter(client).stream({...req(),signal:b.signal}).catch(e=>e);
  for(let n=0;n<100&&seen.length<2;n++)await new Promise(r=>setTimeout(r,10));
  await expect(createPCModelAdapter(client).stream(req())).rejects.toMatchObject({status:429});
  a.abort();b.abort();expect((await p1).name).toBe('AbortError');expect((await p2).name).toBe('AbortError');
  for(let n=0;n<100&&aborted<2;n++)await new Promise(r=>setTimeout(r,10));expect(aborted).toBe(2);
});
it('演示配置、坏请求和旧服务器不会伪装执行成功',async()=>{
  await client.putConfig({provider:'mock'});await expect(createPCModelAdapter(client).stream(req())).rejects.toMatchObject({status:409});
  await expect(createPCModelAdapter({status:async()=>({features:{}})}).stream(req())).rejects.toThrow('立即更新服务器');
  expect(()=>bridgeInput({...req(),tools:[{name:'../bad',description:'x',input_schema:{}}]})).toThrow('工具说明');
  const body=bridgeInput({...req(),baseURL:'http://evil',keys:{custom:'bad'},maxTransientRetries:999,stallTimeouts:{first:999999}});expect(body).not.toHaveProperty('baseURL');expect(body.maxTransientRetries).toBe(1);expect(body.stallTimeouts.first).toBe(60000);
});
it('连接半截断开、空结果不能冒充已完成，SSE心跳不延长等待',async()=>{
  const frame=e=>`data: ${JSON.stringify(e)}\n\n`;
  const fake=text=>({status:async()=>({features:{pcModelBridge:true}}),modelEvents:async()=>new Response(text,{headers:{'Content-Type':'text/event-stream'}})});
  await expect(createPCModelAdapter(fake(frame({type:'text',delta:'half'}))).stream(req())).rejects.toThrow('未收到完整结果');
  await expect(createPCModelAdapter(fake(frame({type:'result',result:{text:'',toolCalls:[]}}))).stream(req())).rejects.toThrow('有效回答');
  vi.useFakeTimers();let ended=false;
  try{
    const pending=createPCModelAdapter({status:async()=>({features:{pcModelBridge:true}}),modelEvents:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': ping\n\n'));},cancel(){ended=true;}}))}).stream(req());
    const check=expect(pending).rejects.toMatchObject({stalled:true});await vi.advanceTimersByTimeAsync(10001);await check;expect(ended).toBe(true);
  }finally{vi.useRealTimers();}
});
