/** 真实三端构建：新样板能读、能入工作区，未发送；旧16方案保留。 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.argv[2]||'/tmp/weiyang-ppt-sources-e2e';await fs.mkdir(out,{recursive:true});
const results=[];const check=(label,pass)=>{results.push({label,pass});console.log(`${pass?'✓':'✗'} ${label}`);};
const types={'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.jpg':'image/jpeg','.svg':'image/svg+xml','.wasm':'application/wasm','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
const server=http.createServer(async(req,res)=>{try{const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const p=path.resolve(root,'.'+(/^\/(assets|vendor)\//.test(requested)?'/dist'+requested:requested));if(!p.startsWith(root+path.sep)||!/^dist(-mobile)?\//.test(path.relative(root,p)))throw Error();const b=await fs.readFile(p);res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});res.end(b);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
try{
 for(const [build,width]of [['dist-mobile',390],['dist',1280],['standalone',390]]){
  const ctx=await browser.newContext({viewport:{width,height:844}});await ctx.route('https://**/*',r=>r.abort());const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(build==='standalone'?pathToFileURL(path.join(root,'dist-standalone/index.html')).href:`${base}/${build}/index.html`);await page.waitForFunction(()=>window.__jarvis?.agents);
  await page.evaluate(async()=>{document.querySelector('#app-splash')?.remove();const app=window.__jarvis;await app.agents.start(await app.agents.profileOf('ppt-maker'));document.querySelector('#prompt').value='帮我做一份季度汇报，重点是节能。';app.agents.library.open();});
  check(`${build} 6个精选样板与16旧方案同时存在`,await page.locator('.wy-ppt-source-detail').count()===6&&await page.locator('.wy-tpl-library .wy-tpl-card').count()===16);
  await page.locator('.wy-ppt-source-detail summary').first().click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.wy-ppt-source-detail[open] img')].every(i=>i.complete&&i.naturalWidth>100));
  check(`${build} 10页技术模板真实预览加载`,await page.locator('.wy-ppt-source-detail[open] img').count()===10);
  check(`${build} 不横向溢出`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:`${out}/${build}.png`});
  await page.locator('.wy-ppt-source-detail[open] .wy-ppt-source-use').click();
  await page.waitForFunction(()=>document.querySelector('#prompt').value.includes('模板样板/'));
  check(`${build} 导入后只填草稿、没有模型任务`,await page.evaluate(()=>document.querySelectorAll('#transcript .msg.user, #transcript .msg.agent').length===0&&document.querySelector('.wy-tpl-library').hidden));
  const file=await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('jarvis');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const get=db.transaction('files').objectStore('files').getAll();get.onsuccess=()=>{resolve(get.result.filter(f=>String(f.id).startsWith('模板样板/')).map(f=>({id:f.id,keys:Object.keys(f),size:f.blob?.size||f.data?.size||f.size})));db.close();};};}));
  check(`${build} PPTX已入工作区`,file.length===1&&/\.pptx$/.test(file[0].id));
  check(`${build} 原来的主题要求保留`,(await page.inputValue('#prompt')).includes('帮我做一份季度汇报，重点是节能。'));
  check(`${build} 无页面异常`,errors.length===0);
  await ctx.close();
 }
 // 文件读取失败保留预览与重试；云端失败/身份隔离另由纯业务测试覆盖。
 const ctx=await browser.newContext({viewport:{width:390,height:844}});await ctx.route('https://**/*',r=>r.abort());const page=await ctx.newPage();await page.goto(`${base}/dist-mobile/index.html`);await page.waitForFunction(()=>window.__jarvis?.agents);
 await page.evaluate(async()=>{document.querySelector('#app-splash')?.remove();const a=window.__jarvis;await a.agents.start(await a.agents.profileOf('ppt-maker'));a.agents.library.open();});
 await page.route('**/*.pptx',r=>r.fulfill({status:503,body:'unavailable'}));
 await page.locator('.wy-ppt-source-detail summary').first().click();await page.locator('.wy-ppt-source-use').first().click();await page.waitForFunction(()=>document.querySelector('.wy-ppt-source-status').textContent.includes('样板读取失败'));
 check('样板读取失败保留预览与重试按钮、无草稿',await page.locator('.wy-tpl-library').isVisible()&&!await page.locator('.wy-ppt-source-use').first().isDisabled()&&await page.inputValue('#prompt')==='');await ctx.close();
 await fs.writeFile(`${out}/checks.json`,JSON.stringify(results,null,2));console.log(`${results.filter(x=>x.pass).length}/${results.length} 通过`);if(results.some(x=>!x.pass))process.exitCode=1;
}finally{await browser.close();await new Promise(r=>server.close(r));}
