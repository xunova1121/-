/** 构建后的手机/PC真实任务与配置隔离；只替换上游，不能以DOM注入伪装工具接入。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
const out = path.resolve(process.argv[2] || '/tmp/weiyang-news-lookup');
await fs.mkdir(out, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-news-lookup-'));
const sock = http.createServer(); await new Promise(r => sock.listen(0, '127.0.0.1', r)); const port = sock.address().port; await new Promise(r => sock.close(r));
const base = 'http://127.0.0.1:' + port, password = 'news-fixture-password';
const child = spawn(process.execPath, ['e2e/fixtures/news-server.mjs'], { env: { ...process.env, PORT: String(port), JARVIS_DATA: data, JARVIS_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, mobileWeb, page;
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const checks = [], check = (label, ok) => { checks.push({ label, ok }); assert.equal(ok, true, label); };
try {
  for (let i=0; i<150 && !logs.includes('news-fixture-ready'); i++) { if (child.exitCode !== null) throw Error(logs); await new Promise(r=>setTimeout(r,100)); }
  assert.ok(logs.includes('news-fixture-ready'), logs);
  const token = (await (await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })).json()).token;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const api = (p, init={}) => fetch(base+p, { ...init, headers });
  const endpoint = '/api/fetch?publicJson=1&url=' + encodeURIComponent('https://data.example.com/api');
  check('json-gateway-requires-login', (await fetch(base + endpoint)).status === 401);
  check('json-gateway-real-public-data', (await (await api(endpoint)).json()).count === 18);
  for (const url of ['https://data.example.com/redirect', 'https://private.example.com/api', 'http://data.example.com/api']) {
    const response = await api('/api/fetch?publicJson=1&url='+encodeURIComponent(url));
    check('json-gateway-blocks-'+url, response.status >= 400);
  }
  const root = path.resolve('dist-mobile');
  mobileWeb = http.createServer(async (req,res) => {
    try { const file = path.resolve(root, new URL(req.url,'http://x').pathname.slice(1)||'index.html'); if (!file.startsWith(root+path.sep)) throw Error('outside'); res.setHeader('Content-Type', {'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream'); res.end(await fs.readFile(file)); } catch {res.writeHead(404);res.end();}
  });
  await new Promise(r=>mobileWeb.listen(0,'127.0.0.1',r));
  browser = await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  for (const width of [390,1280]) {
    const context = await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500});
    await context.addInitScript(({base,token})=>{
      localStorage.setItem('jarvis.server.v1',JSON.stringify({enabled:true,url:base,token}));
      localStorage.setItem('jarvis.llm.v1',JSON.stringify({provider:'mock',models:{},keys:{},publicDataHosts:['api.github.com']}));
      localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false}));
    },{base,token});
    page = await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(width<500 ? 'http://127.0.0.1:'+mobileWeb.address().port : base);
    await page.waitForFunction(()=>window.__jarvis);
    await page.evaluate(()=>{document.body.classList.add('side-closed');document.body.classList.remove('side-open');});
    const before=JSON.parse(await fs.readFile(path.join(data,'news-stats.json')));
    await page.fill('#prompt','今日新闻');await page.click('#btn-send');
    await page.waitForFunction(()=>document.querySelector('.msg.agent .body')?.textContent?.includes('先给你已经取得') && !document.querySelector('.msg.agent.streaming'),null,{timeout:30000});
    const after=JSON.parse(await fs.readFile(path.join(data,'news-stats.json')));
    const answer = await page.locator('.msg.agent').last().textContent();
    check(width+'-actual-domestic-and-international-sources', after.upstream-before.upstream===8);
    check(width+'-bbc-and-verified-reuters-reprint', answer.includes('BBC') && answer.includes('路透（CNA转载）') && answer.includes('CNA转载页发布时间'));
    check(width+'-one-model-and-real-content', after.models-before.models===1 && answer.includes('三项便民服务') && answer.includes('待核实'));
    await page.screenshot({path:path.join(out,'news-'+width+'.png')});
    await page.fill('#prompt','发个新闻那么慢');await page.click('#btn-send');
    await page.waitForFunction(()=>[...document.querySelectorAll('.msg.agent')].some(el=>el.textContent.includes('没有重新联网')) && !document.querySelector('.msg.agent.streaming'));
    const complaint=JSON.parse(await fs.readFile(path.join(data,'news-stats.json')));
    check(width+'-complaint-no-network',complaint.upstream===after.upstream);
    await page.fill('#prompt','体育资讯');await page.click('#btn-send');
    await page.waitForFunction(()=>[...document.querySelectorAll('.msg.agent')].at(-1)?.textContent.includes('虚构体育报道') && !document.querySelector('.msg.agent.streaming'),null,{timeout:30000});
    const sportsNews = page.locator('.msg.agent').last();
    const sportsStats = JSON.parse(await fs.readFile(path.join(data,'news-stats.json')));
    check(width+'-sports-reads-news-not-score-api', sportsStats.upstream-complaint.upstream===6 && await sportsNews.locator('.sports-card').count()===0);
    check(width+'-sports-news-has-international-reporting', (await sportsNews.textContent()).includes('BBC') && (await sportsNews.textContent()).includes('路透（CNA转载）'));
    await page.screenshot({path:path.join(out,'sports-news-'+width+'.png')});
    await page.evaluate(()=>window.__jarvis.showPanel('models'));
    await page.waitForSelector('.ml-public-data',{state:'attached'});
    if(width<500)await page.getByRole('navigation',{name:'模型中心分类'}).getByRole('button',{name:'服务商',exact:true}).click();
    await page.locator('.ml-public-data summary').click();
    await page.getByLabel('公开数据可信域名').fill('data.example.com\napi.github.com');
    await page.getByRole('button',{name:'保存可信域名',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ml-public-data [role=status]')?.textContent.includes('已保存到云服务器'));
    check(width+'-cloud-domain-saved',(await (await api('/api/server/config')).json()).publicDataHosts.includes('data.example.com'));
    check(width+'-local-domain-not-overwritten',await page.evaluate(()=>JSON.parse(localStorage.getItem('jarvis.llm.v1')).publicDataHosts.join(',')==='api.github.com'));
    await page.getByLabel('公开数据可信域名').fill('');await page.getByRole('button',{name:'保存可信域名',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ml-public-data [role=status]')?.textContent.includes('共0个域名'));
    check(width+'-empty-list-disables',(await (await api('/api/server/config')).json()).publicDataHosts.length===0);
    check(width+'-no-browser-errors',errors.length===0);
    await context.close();page=null;
  }
  const list=await (await api('/api/sessions')).json();
  const session=await (await api('/api/sessions/'+list[0].id)).json();
  check('history-persists-actual-news',JSON.stringify(session.messages).includes('三项便民服务'));
  check('history-does-not-store-html',!JSON.stringify(session.messages).includes('ui-zxlist-item'));
  console.log(`新闻与公开数据链路：${checks.length}/${checks.length}`);
} catch(error) {
  if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();if(mobileWeb)await new Promise(r=>mobileWeb.close(r));child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({checks},null,2));await fs.writeFile(path.join(out,'server.log'),logs);await fs.rm(data,{recursive:true,force:true});
}
