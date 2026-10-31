import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessDelivery,main,privateValues} from '../evals/ppt-delivery-live.mjs';

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
