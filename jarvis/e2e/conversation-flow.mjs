/** 实际手机构建：从输入框发送生成中补充、附件及停止，不只调用调试send。 */
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
const root=path.resolve('dist-mobile'),requests=[];let held=null,first=true;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/release'){held?.();held=null;res.end('ok');return;}
 if(req.method==='POST'&&url.pathname.endsWith('/chat/completions')){
  const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts));requests.push(body);
  res.setHeader('Content-Type','text/event-stream');
  const text=t=>res.write('data: '+JSON.stringify({choices:[{delta:{content:t}}]})+'\n\n');
  const finish=()=>{if(!res.destroyed){text('补充要求与文件已纳入计划。');res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}};
  text('我先整理资料。');
  if(first){first=false;held=finish;}
  else if(body.messages.at(-1)?.content==='需要停止的任务'){/* 等待用户停止，不自行完成 */}
  else finish();return;
 }
 try{const target=path.resolve(root,url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)));if(!target.startsWith(root+path.sep))throw Error('outside');const data=await readFile(target);res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml'})[path.extname(target)]||'application/octet-stream');res.end(data);}catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch();let failed=0;const check=(name,ok)=>{console.log((ok?'✓':'✗')+' '+name);if(!ok)failed++;};
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await ctx.addInitScript(base=>{
  localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false,autoMemory:false,teamMode:'off'}));
  localStorage.setItem('jarvis.llm.v1',JSON.stringify({provider:'custom',models:{custom:'flow-test'},keys:{custom:'sk-test'},baseURLs:{custom:base+'/v1'},routing:{enabled:false}}));
 },base);
 const page=await ctx.newPage();await page.goto(base);await page.waitForFunction(()=>window.__jarvis?.send);
 await page.fill('#prompt','生成中途补充的验收计划');await page.click('#btn-send');await page.waitForSelector('.msg.agent.streaming .body');
 await page.waitForFunction(()=>document.querySelector('.msg.agent.streaming .body')?.textContent.includes('整理资料'));
 await page.evaluate(()=>window.__jarvis.voice.onConfirm?.());
 check('检测到用户开口不会终止当前任务',await page.locator('.msg.agent.streaming').count()===1);
 await page.fill('#prompt','补充要求：控制在三页，保留出处');
 check('生成中可以同时使用发送和停止',await page.isVisible('#btn-send')&&await page.isVisible('#btn-stop')&&await page.isEnabled('#btn-send'));
 await page.click('#btn-send');
 await page.setInputFiles('#file-input',{name:'补充说明.txt',mimeType:'text/plain',buffer:Buffer.from('完整附件要求')});
 await page.waitForFunction(()=>document.querySelector('#attach-list').children.length>0);await page.click('#btn-send');
 check('只有附件也能在生成中补充，不取消当前任务',await page.locator('.msg.agent.streaming').count()===1);
 await fetch(base+'/release');await page.waitForFunction(()=>!document.querySelector('.msg.agent.streaming'),null,{timeout:20000});
 const sent=JSON.stringify(requests);check('补充原话和附件路径实际送到后续模型请求',sent.includes('控制在三页')&&sent.includes('补充说明.txt'));
 check('补充没有被当成停止',!(await page.locator('#transcript').innerText()).includes('已打断'));
 await page.fill('#prompt','需要停止的任务');await page.click('#btn-send');await page.waitForFunction(()=>document.querySelector('.msg.agent.streaming .body')?.textContent.includes('整理资料'));
 await page.click('#btn-stop');await page.waitForFunction(()=>!document.querySelector('.msg.agent.streaming'));
 await page.waitForFunction(async()=>{const s=await window.__jarvis.sessionGet(window.__jarvis.sessionId);return s?.messages.some(m=>m.role==='assistant'&&m.content.includes('我先整理资料')&&m.content.includes('还没完成'));},null,{timeout:5000});
 check('点击独立停止保留已经生成的内容',await page.locator('#transcript').innerText().then(t=>t.includes('已打断')&&t.includes('我先整理资料')));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
if(failed)process.exitCode=1;
