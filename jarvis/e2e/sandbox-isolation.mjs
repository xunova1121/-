/** 在真实Chromium中验证来源隔离、禁网和终止，不以Worker模拟替代。 */
import {chromium} from 'playwright';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/agent/sandbox.js',import.meta.url),'utf8');
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/src/agent/sandbox.js'){res.setHeader('Content-Type','application/javascript');res.end(source);}
 else if(url.pathname==='/src/config.js'){res.setHeader('Content-Type','application/javascript');res.end('export const MOBILE=false;');}
 else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body></body>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,browser=await chromium.launch();
let failures=0,network=0;
const check=(name,ok)=>{console.log((ok?'✓':'✗')+' '+name);if(!ok)failures++;};
try{
 const page=await browser.newPage();await page.route('**/src/main.js',r=>r.abort());
 await page.route('**/sandbox-network-probe',r=>{network++;return r.fulfill({body:'should not reach'});});
 await page.goto('http://127.0.0.1:'+port);
 const results=await page.evaluate(async base=>{
  const {runJavaScript}=await import('/src/agent/sandbox.js');
  localStorage.setItem('sandbox-secret','private');
  Object.defineProperty(crypto,'randomUUID',{configurable:true,value:undefined}); // 普通HTTP环境没有randomUUID，仍需可运行。
  const sum=await runJavaScript('console.log("计算");return 2+3');
  const storage=await runJavaScript('try{await indexedDB.databases();return "leaked"}catch(e){return e.name}');
  const net=await runJavaScript('try{await fetch('+JSON.stringify(base+'/sandbox-network-probe')+');return "leaked"}catch(e){return "blocked"}');
  const timeout=await runJavaScript('while(true){}',{timeout:250});
  const ctrl=new AbortController(),canceled=runJavaScript('await new Promise(()=>{})',{signal:ctrl.signal});setTimeout(()=>ctrl.abort(),100);
  return {sum,storage,net,timeout,canceled:await canceled,frames:document.querySelectorAll('iframe[sandbox="allow-scripts"]').length};
 },'http://127.0.0.1:'+port);
 check('隔离环境实际执行计算和日志',results.sum.ok&&results.sum.value==='5'&&results.sum.logs.includes('计算'));
 check('不能访问应用IndexedDB',results.storage.value==='SecurityError');
 check('联网由CSP拦截，请求没有发出',results.net.value==='blocked'&&network===0);
 check('死循环超时被终止',!results.timeout.ok&&results.timeout.error.includes('已终止'));
 check('用户停止立即清理隔离环境',!results.canceled.ok&&results.canceled.error.includes('停止')&&results.frames===0);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
if(failures)process.exitCode=1;
