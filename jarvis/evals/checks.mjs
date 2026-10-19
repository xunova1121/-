import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTaskTiming } from '../shared/taskTiming.js';
import { cases } from './cases.mjs';
import { serverAPI, runCase, summarize, main } from './runner.mjs';

test('60题分类完整、编号唯一、实时题有来源验收、长任务含补充',()=>{
  assert.equal(cases.length,60); assert.equal(new Set(cases.map(c=>c.id)).size,60);
  assert.deepEqual(Object.fromEntries(['dialogue','search','documents','coding','long_task'].map(k=>[k,cases.filter(c=>c.category===k).length])),{dialogue:10,search:15,documents:15,coding:10,long_task:10});
  for(const c of cases){assert.ok(c.rubric.length>10);assert.ok(c.timeoutMs>c.targetMs);if(c.category==='long_task')assert.ok(c.note);}
});
test('默认只预览，不需要配置或调用真实服务',async()=>{
  const old=console.log;let printed='';console.log=s=>printed+=s;
  try{await main([],{});assert.equal(JSON.parse(printed).mode,'plan_only');assert.equal(JSON.parse(printed).selected.length,3);}
  finally{console.log=old;}
});
test('诊断区分排队、上下文、首字、模型、重试回退和并行工具，不记录正文',()=>{
  let t=0;const x=createTaskTiming(0,()=>t);
  t=100;x.start();t=130;x.event({type:'timing',contextMs:30});
  x.event({type:'diagnostic',phase:'model_start'});t=140;x.event({type:'text',delta:'   '});
  t=180;x.event({type:'text',delta:'sensitive answer'});t=200;x.event({type:'diagnostic',phase:'model_end'});
  x.event({type:'tool_start',id:'a',args:{apiKey:'secret'}});t=220;x.event({type:'tool_start',id:'b'});
  t=250;x.event({type:'tool_end',id:'a',ok:true});t=270;x.event({type:'tool_end',id:'b',ok:false});
  x.event({type:'retry'});x.event({type:'fallback'});x.event({type:'server_tool',name:'web_search'});t=300;
  const r=x.finish();assert.equal(r.queueMs,100);assert.equal(r.contextMs,30);assert.equal(r.firstTextMs,180);
  assert.equal(r.modelMs,70);assert.equal(r.toolMs,70);assert.equal(r.executionMs,200);assert.equal(r.totalMs,300);
  assert.equal(r.failedTools,1);assert.equal(r.retries,1);assert.equal(r.fallbacks,1);assert.equal(r.nativeSearchCalls,1);
  assert.ok(!JSON.stringify(r).includes('secret'));assert.ok(!JSON.stringify(r).includes('sensitive'));
  t=500;x.event({type:'text',delta:'late'});assert.deepEqual(x.snapshot(),r);
});
test('取消排队/模型卡住都保留耗时；零时刻首字有效；快照不暴露可变引用',()=>{
  let t=0;const queued=createTaskTiming(0,()=>t);t=50;assert.equal(queued.finish().queueMs,50);assert.equal(queued.snapshot().executionMs,null);
  t=0;const x=createTaskTiming(0,()=>t);x.start();x.event({type:'text',delta:'hello'});x.event({type:'diagnostic',phase:'model_start'});
  t=60;const r=x.finish();assert.equal(r.firstTextMs,0);assert.equal(r.modelMs,60);r.modelMs=999;assert.equal(x.snapshot().modelMs,60);
});
test('实际HTTP客户端发送认证、不跟随重定向、不返回响应正文',async()=>{
  let auth;
  const server=createServer((req,res)=>{auth=req.headers.authorization;if(req.url==='/redirect'){res.writeHead(302,{location:'/leak'});res.end();}else if(req.url==='/failure'){res.writeHead(403);res.end('secret-response');}else{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const api=serverAPI(`http://127.0.0.1:${server.address().port}`,'test-only');assert.deepEqual(await api('/ok'),{ok:true});assert.equal(auth,'Bearer test-only');await assert.rejects(api('/redirect'));await assert.rejects(api('/failure'),e=>!e.message.includes('secret-response'));}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  assert.throws(()=>serverAPI('http://remote.example','x'));assert.throws(()=>serverAPI('https://user:pass@remote.example','x'));
});
test('完成并不自动合格；普通与补充题保持独立任务，未知成本不冒充零',async()=>{
  let t=0;const sent=[];let n=0;
  const api=async(route,body)=>{sent.push([route,body]);if(route==='/api/tasks')return{id:'task',sessionId:'session'};if(route.endsWith('/notes'))return{id:'task',joined:true};if(route==='/api/tasks/task')return ++n===1?{status:'running'}:{status:'done',timing:{firstTextMs:12},files:['a.docx']};if(route==='/api/sessions/session')return{messages:[{role:'assistant',content:'answer'}]};throw Error('unexpected');};
  const r=await runCase(api,cases.at(-1),{runId:'test',now:()=>t,wait:async ms=>{t+=ms;}});
  assert.equal(r.status,'done');assert.equal(r.quality,'not_reviewed');assert.equal(r.cost,null);assert.equal(r.note.sent,true);assert.equal(r.artifactReview,'not_checked');
  assert.equal(sent.filter(([p])=>p==='/api/tasks').length,1);assert.ok(sent[0][1].text.includes('evals/test/long_task-10'));
  const s=summarize([r]);assert.equal(s.verifiedPassed,0);assert.equal(s.pendingReview,1);
});
test('268秒假响应在评测总预算结束时停止，不以超时当成功',async()=>{
  let t=0,stops=0;const api=async(route)=>{if(route==='/api/tasks')return{id:'t',sessionId:'s'};if(route.endsWith('/stop')){stops++;return{ok:true};}return{status:'running'};};
  const r=await runCase(api,{...cases[10],timeoutMs:2000},{now:()=>t,wait:async ms=>{t+=ms;}});
  assert.equal(r.status,'client_timeout');assert.equal(r.stopRequested,true);assert.equal(stops,1);assert.equal(summarize([r]).verifiedPassed,0);
});
test('提交不确定不能自动重复；错误不泄露令牌；已接收但读取失败请求停止',async()=>{
  let calls=0;let r=await runCase(async()=>{calls++;throw Error('Bearer secret');},cases[0]);
  assert.equal(calls,1);assert.equal(r.status,'submission_unknown');assert.ok(!JSON.stringify(r).includes('Bearer'));
  let stops=0;r=await runCase(async(route)=>{if(route==='/api/tasks')return{id:'t',sessionId:'s'};if(route.endsWith('/stop')){stops++;return{ok:true};}throw Error('secret');},cases[0]);
  assert.equal(r.status,'transport_or_protocol_error');assert.equal(stops,1);
});
test('追加前已结束必须注明未覆盖补充场景，不能算通过',async()=>{
  const api=async(route)=>route==='/api/tasks'?{id:'t',sessionId:'s'}:route==='/api/tasks/t'?{status:'done',files:[]}:{messages:[]};
  const r=await runCase(api,cases.at(-1));assert.equal(r.note.sent,false);assert.ok(r.protocolIssue);r.quality='passed';assert.equal(summarize([r]).verifiedPassed,0);
});
test('取消评测会停止已知任务，预取消不提交',async()=>{
  const ctrl=new AbortController();ctrl.abort();let calls=0;
  const early=await runCase(async()=>{calls++;},cases[0],{signal:ctrl.signal});
  assert.equal(early.status,'client_cancelled');assert.equal(calls,0);
  const active=new AbortController();let stops=0;
  const api=async route=>{if(route==='/api/tasks')return{id:'t',sessionId:'s'};if(route.endsWith('/stop')){stops++;return{ok:true};}return{status:'running'};};
  const r=await runCase(api,cases[0],{signal:active.signal,wait:async()=>active.abort()});
  assert.equal(r.status,'client_cancelled');assert.equal(stops,1);
});
