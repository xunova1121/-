import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessDelivery,main,privateValues,deliverySequence} from '../evals/ppt-delivery-live.mjs';

test('done、图标或部分配图不能冒充逐页配齐；耗时超目标仍失败',()=>{
 const value={step:3,status:'done',elapsedMs:1000,rendered:true,renderedPages:5,quality:{slides:5,errors:0,presentation:{imagePages:4}}};
 expect(assessDelivery(value).state).toBe('failed');
 value.quality.presentation.imagePages=5;expect(assessDelivery(value)).toMatchObject({state:'mechanical_pass',visual:'not_reviewed',answer:'not_reviewed'});
 expect(assessDelivery({...value,renderedPages:6}).state).toBe('failed');
 value.elapsedMs=180000;expect(assessDelivery(value).state).toBe('failed');
});
test('Word横线、丢记录、缺真实PDF及超页数都不能通过',()=>{
 const good={step:1,status:'done',elapsedMs:1000,rendered:true,quality:{errors:0},rules:0};
 expect(assessDelivery(good).state).toBe('mechanical_pass');
 for(const change of [{rules:1},{missing:['赛事01']},{rendered:false},{elapsedMs:60000},{status:'error'}])expect(assessDelivery({...good,...change}).state).toBe('failed');
 expect(assessDelivery({...good,step:2,quality:{errors:0,slides:7}}).state).toBe('failed');
});
test('未配置真实模型不请求模型，不修改生产数据，报告不复制Key',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ppt-live-test-')),production=path.join(root,'production'),out=path.join(root,'result');
 await fs.mkdir(production);const config=JSON.stringify({provider:'mock',openaiKey:'private-test-secret-123'});await fs.writeFile(path.join(production,'config.json'),config);
 try{
  const report=await main(['--live','--data-dir='+production,'--out-dir='+out]);
  expect(report.state).toBe('blocked_or_error');expect(report.cases).toEqual([]);
  expect(await fs.readFile(path.join(out,'report.json'),'utf8')).not.toContain('private-test-secret-123');
  expect(await fs.readFile(path.join(production,'config.json'),'utf8')).toBe(config);
  expect(await fs.readdir(production)).toEqual(['config.json']);
  await expect(main(['--live','--data-dir='+production,'--out-dir='+production+'/results'])).rejects.toThrow('独立新目录');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("嵌套服务商keys中的值也会脱敏",()=>{expect(privateValues({keys:{custom:"private-provider-key"},model:"public-model",nested:{token:"private-token"}})).toEqual(["private-provider-key","private-token"]);});

 test('真实隔离绑定规则允许同会话连续三步，仍拒绝跨评测接入',async()=>{
 const {bindEvaluation}=await import('../server/evaluation.mjs');
 const session={messages:[]},calls=[];
 const runner={start:async input=>{bindEvaluation(session,input.evaluationId);session.messages.push({role:'user',content:input.text});calls.push(input);return {id:'t'+calls.length,sessionId:'c_delivery'};}};
 const next=deliverySequence(runner);
 for(const text of ['制作Word','沿用Word做PPT','逐页补图'])await next(text);
 expect(calls.map(x=>x.sessionId)).toEqual([null,'c_delivery','c_delivery']);
 expect(new Set(calls.map(x=>x.requestId)).size).toBe(3);
 expect(()=>bindEvaluation(session,'another-evaluation')).toThrow('另一套评测');
 });

test('停止后仍导出已有图片和Office，不复制配置/会话', async () => {
 const {exportDeliveryRecovery}=await import('../evals/delivery-recovery.mjs');
 const {createFileStore}=await import('../server/fileStore.mjs');
 const {useBackend}=await import('../src/agent/store.js');
 const ws=await import('../src/agent/workspace.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ppt-recovery-'));
 useBackend(createFileStore(path.join(root,'state')));
 try {
  await ws.write('images/成功.png',new Blob(['image']));
  await ws.write('outputs/原PPT.pptx',new Blob(['ppt']));
  await ws.write('outputs/config.json','private-secret');
  const result=await exportDeliveryRecovery(path.join(root,'export'));
  expect(result.files.map(x=>x.path)).toEqual(['images/成功.png','outputs/原PPT.pptx']);
  expect(await fs.readFile(path.join(root,'export/recovery/images/成功.png'),'utf8')).toBe('image');
  await expect(fs.stat(path.join(root,'export/recovery/outputs/config.json'))).rejects.toThrow();
 } finally {useBackend(null);await fs.rm(root,{recursive:true,force:true});}
});
test('结果包显式包含中间资产恢复目录，不包含隔离state',async()=>{
 const launcher=await fs.readFile(new URL('../evals/run-ppt-delivery-server.sh',import.meta.url),'utf8');
 expect(launcher).toContain('MEMBERS+=(recovery)');
 expect(launcher).not.toMatch(/MEMBERS\+=\(state\)/);
});
