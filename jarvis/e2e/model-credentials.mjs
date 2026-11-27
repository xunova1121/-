/** 真浏览器保存→真实云端HTTP→任务→适配器；仅OpenRouter上游用固定替身，不使用真实Key/额度。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
const output = process.argv[2] || '/tmp/weiyang-model-credentials';
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weiyang-credentials-'));
const originalFetch=globalThis.fetch,oldEnv=process.env.OPENROUTER_API_KEY;
const current='sk-or-v1-fixture-new-4321',stale='sk-or-v1-fixture-old-9876';
const model='deepseek/deepseek-v4.1-flash-1017';
let rejectModel=false;
const calls=[];
process.env.OPENROUTER_API_KEY=stale;
globalThis.fetch=async(input,init)=>{
  if(String(input).startsWith('https://openrouter.ai/api/v1/')){
    calls.push({url:String(input),key:new Headers(init?.headers).get('Authorization'),model:JSON.parse(init?.body||'{}').model});
    if(rejectModel)return new Response(JSON.stringify({error:{message:`User not found. ${current}`}}),{status:401});
    return new Response('data: {"choices":[{"delta":{"content":"你好，已收到。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }
  return originalFetch(input,init);
};
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({provider:'openrouter',models:{openrouter:model},keys:{openrouter:stale},pinModel:true,fallbackPolicy:'explicit',fallbackModels:[],reflectionEnabled:false}));
const pass='fixture-password';
const mode=createServerMode({dataDir:dir,password:pass});await mode.ready;
const http=createServer({serverMode:mode,ollama:null});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${http.address().port}`;
const browser=await chromium.launch();
const checks=[];
const check=(label,ok)=>{assert.ok(ok,label);checks.push(label);console.log('✓ '+label);};
try{
  for(const width of [1280,390]){
    const old=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({...old,keys:{...old.keys,openrouter:stale}}));
    const context=await browser.newContext({viewport:{width,height:900}});
    await context.addInitScript(({base,token})=>localStorage.setItem('jarvis.server.v1',JSON.stringify({url:base,token,enabled:true})),{base,token:tokenFor(pass)});
    const page=await context.newPage();
    await page.goto(base);await page.waitForFunction(()=>window.__jarvis?.showPanel);
    await page.evaluate(()=>window.__jarvis.showPanel('models'));
    if(width===390) await page.getByRole('button',{name:'服务商',exact:true}).click();
    const card=page.locator('.ml-provider').filter({has:page.getByText('OpenRouter（聚合）',{exact:true})});
    await card.getByRole('button',{name:'配置 ›',exact:true}).click();
    await card.getByLabel('API Key').fill(current);
    const pretendSave=async route=>route.request().method()==='PUT'?route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}):route.continue();
    await page.route('**/api/server/config',pretendSave);
    await card.getByRole('button',{name:'保存服务商',exact:true}).click();
    await page.getByText(/云服务器Key读回核对不一致/).waitFor();
    check(`${width} 未真正保存时明确报错`,JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')).keys.openrouter===stale);
    await page.unroute('**/api/server/config',pretendSave);
    await card.getByRole('button',{name:'配置 ›',exact:true}).click();
    await card.getByLabel('API Key').fill(current);
    await card.getByRole('button',{name:'保存服务商',exact:true}).click();
    await page.getByText(/已保存到云服务器并读回核对/).waitFor();
    const disk=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
    check(`${width} 面板Key实际保存到服务器`,disk.keys.openrouter===current);
    check(`${width} 本机不保存云端Key`,!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(current));
    const visible=await page.locator('body').innerText();
    check(`${width} 保存回执只显示末四位`,visible.includes('Key 末4位：4321')&&!visible.includes(current));
    const auth=await page.evaluate(()=>JSON.parse(localStorage.getItem('jarvis.server.v1')).token);
    const headers={Authorization:'Bearer '+auth,'Content-Type':'application/json'};
    const run=async()=>{
      const response=await originalFetch(base+'/api/tasks',{method:'POST',headers,body:JSON.stringify({text:'你好'})});assert.equal(response.status,200);
      const {id}=await response.json();
      for(let i=0;i<300;i++){
        const task=await (await originalFetch(base+'/api/tasks/'+id,{headers})).json();
        if(['done','error'].includes(task.status))return task;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('任务未结束');
    };
    rejectModel=false;calls.length=0;
    const success=await run();
    check(`${width} 实际任务发送新Key而非旧环境Key`,success.status==='done'&&calls.length>0&&calls.every(x=>x.key==='Bearer '+current&&x.model===model));
    rejectModel=true;
    const failure=await run();
    check(`${width} 401回传实际服务商和Key来源及末四位`,failure.status==='error'&&/OpenRouter/.test(failure.error)&&/云服务器设置/.test(failure.error)&&/4321/.test(failure.error)&&!JSON.stringify(failure).includes(current));
    await page.evaluate(()=>{document.body.classList.add('side-closed');document.body.classList.remove('side-open');window.__jarvis.send('你好');});
    await page.waitForFunction(()=>document.querySelector('#transcript')?.textContent.includes('Key 来源：云服务器设置'));
    const answer=await page.locator('#transcript').innerText();
    check(`${width} 聊天气泡保留可对照的401诊断`,answer.includes('OpenRouter')&&answer.includes('Key 末4位：4321')&&!answer.includes(current));
    await page.screenshot({path:path.join(output,`saved-${width}.png`)});
    await context.close();
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({state:'passed',checks,realModelTested:false},null,2));
}finally{
  await browser.close();await mode.runner.settled();http.closeAllConnections();await new Promise(r=>http.close(r));useBackend(null);
  globalThis.fetch=originalFetch;if(oldEnv===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldEnv;
  fs.rmSync(dir,{recursive:true,force:true});
}
