/** 独立设计稿校验与2倍图；不能代替真实App/真机验收。 */
import { chromium } from '../../../jarvis/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=process.argv[2]||'/workspace/artifacts/agent-square-v2-20261105';
await fs.mkdir(out,{recursive:true});
const types={'.html':'text/html;charset=utf-8','.js':'application/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  try{const p=path.resolve(here,'.'+new URL(req.url,'http://localhost').pathname);if(!p.startsWith(here+path.sep))throw Error();const b=await fs.readFile(p);res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});res.end(b);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
const page=await ctx.newPage(),errors=[],requests=[],checks=[];
const check=(label,pass)=>{checks.push({label,pass});if(!pass)console.log('FAIL',label);};
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(base))requests.push(r.url());});
const url=(p,t='light')=>`${base}/index.html?page=${p}&theme=${t}`;
try{
 await page.goto(url('square'));
 const pages=await page.evaluate(()=>window.design.pages);
 for(const theme of ['light','dark'])for(const [id]of pages){
  await page.setViewportSize({width:390,height:844});await page.goto(url(id,theme));await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:`${out}/${id}-${theme}.png`});
  const fullStyle=await page.addStyleTag({content:".bottom-action{position:static}#content .with-bottom{padding-bottom:28px}"});
  await page.screenshot({path:`${out}/${id}-${theme}-full.png`,fullPage:true});await fullStyle.evaluate(el=>el.remove());
  for(const width of [320,390,412])for(const scale of [1,1.3]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(s=>document.documentElement.style.fontSize=16*s+'px',scale);
   check(`${id}/${theme}/${width}/${scale}不横向溢出`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
 }
 for(const id of ['square','ppt','gongwen','poster','health']){
  await page.setViewportSize({width:1280,height:900});await page.goto(url(id));await page.screenshot({path:`${out}/desktop-${id}.png`,fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});await page.goto(url('square'));await page.fill('#search','找不到123');check('搜索空态',await page.locator('.empty').count()===1);
 await page.goto(url('ppt'));await page.fill('#topic','保留主题和场景');await page.selectOption('#pages','20–30 页');await page.click('[data-template="1"]');await page.click('[data-slide="3"]');check('第三页是真实截图',await page.locator('#preview-image').getAttribute('alt').then(x=>x.includes('第3页')));await page.click('[data-action="choose"]');check('选择返回保留输入和页数',await page.locator('#topic').inputValue()==='保留主题和场景'&&await page.locator('#pages').inputValue()==='20–30 页');
 await page.goto(url('health'));await page.locator('[data-starter]').first().click();check('问题仅填入不发送',await page.locator('#composer').inputValue()==='帮我看懂这份体检报告');
 await page.goto(url('tools'));check('未上传不能处理',await page.locator('.primary').isDisabled());
 await page.goto(url('poster-create'));await page.fill('#poster-text','保留输入的海报需求');await page.click('[data-style="质感摄影"]');await page.click('[data-ratio="3:4"]');check('换风格尺寸保留需求',await page.locator('#poster-text').inputValue()==='保留输入的海报需求');
 check('无脚本异常',errors.length===0);check('无外部联网',requests.length===0);
 await fs.writeFile(`${out}/checks.json`,JSON.stringify({checks,errors,requests},null,2));
 console.log(`${checks.filter(c=>c.pass).length}/${checks.length} design checks; ${out}`);
 if(checks.some(c=>!c.pass))process.exitCode=1;
}finally{await browser.close();await new Promise(r=>server.close(r));}
