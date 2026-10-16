/** 验证真正 build:mobile 产物的角色、输入区和键盘布局；不把浏览器测试当作鸿蒙语音实测。 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist-mobile');
const OUT=process.argv[2]||'.';await mkdir(OUT,{recursive:true});
const results=[];const check=(name,ok,detail='')=>{results.push(ok);console.log(`${ok?'✓':'✗'} ${name}${detail?' — '+detail:''}`);};
const longReply=Array.from({length:18},(_,i)=>`第 ${i+1} 项：我会先核对资料，再整理成清楚的计划。你可以慢慢阅读，有需要的时候再继续。`).join('\n\n');
const server=http.createServer(async(req,res)=>{
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'};
  if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method==='POST'&&pathname.endsWith('/chat/completions')){
    req.resume();req.on('end',()=>{
      res.writeHead(200,{...headers,'Content-Type':'text/event-stream'});
      const chunk=content=>res.write(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`);
      chunk(longReply.slice(0,260));
      setTimeout(()=>chunk(longReply.slice(260,600)),250);
      setTimeout(()=>{chunk(longReply.slice(600));res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');},600);
    });return;
  }
  try{
    const target=path.resolve(ROOT,decodeURIComponent(pathname==='/'?'index.html':pathname.slice(1)));
    if(!target.startsWith(ROOT+path.sep)&&target!==path.join(ROOT,'index.html'))throw Error('outside');
    const data=await readFile(target);const type={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.wasm':'application/wasm','.json':'application/json'}[path.extname(target)]||'application/octet-stream';
    res.writeHead(200,{...headers,'Content-Type':type});res.end(data);
  }catch{res.writeHead(404,headers);res.end('not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const BASE=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
try{
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await ctx.addInitScript(()=>{
    if (window.top !== window) return;
    localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false}));
    const viewport=Object.assign(new EventTarget(),{height:844,width:390,offsetTop:0,offsetLeft:0,scale:1});
    Object.defineProperty(window,'visualViewport',{configurable:true,get:()=>viewport});
    window.__resizeKeyboard=height=>{viewport.height=height;viewport.dispatchEvent(new Event('resize'));};
  });
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE);await page.waitForSelector('body.compact.companion-edition');
  await page.waitForFunction(()=>window.__jarvis&&document.querySelector('#app-splash')?.hidden!==false);await page.waitForTimeout(400);
  check('手机版实际产物启用陪伴感布局',await page.evaluate(()=>document.body.classList.contains('compact')&&!document.body.classList.contains('workbench')&&window.__jarvis.stage===null));
  check('手机近白底色，保留清楚的未央图标',await page.evaluate(()=>{const r=document.querySelector('.brand-mark').getBoundingClientRect();return r.width>=44&&r.height>=44&&getComputedStyle(document.body).backgroundColor==='rgb(252, 251, 255)';}));
  check('手机输入区保留附件、拍照、语音、发送',await page.evaluate(()=>['btn-attach','btn-camera','btn-call','btn-send'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>=32&&r.height>=36;})));
  async function ask(text){const before=await page.locator('.msg.agent').count();await page.fill('#prompt',text);await page.press('#prompt','Enter');await page.waitForFunction(n=>document.querySelectorAll('.msg.agent').length>n&&!document.querySelector('.msg.agent.streaming'),before,{timeout:30000});await page.waitForTimeout(120);}
  await ask('你好');
  check('手机短回复有较大的单个表情角色和短回应',await page.locator('.msg.agent').last().evaluate(el=>{const who=el.querySelector('.who');return who.querySelectorAll('.wy-mascot').length===1&&who.querySelector('.wy-mascot').getBoundingClientRect().height>=120&&getComputedStyle(who.querySelector('.wy-reply-greeting')).display!=='none';}));
  await page.focus('#prompt');await page.evaluate(()=>window.__resizeKeyboard(444));await page.waitForTimeout(80);
  check('键盘弹出时角色缩小且发送按钮保持可见',await page.evaluate(()=>{const r=document.querySelector('.msg.agent:last-child .who .wy-mascot').getBoundingClientRect(),send=document.getElementById('btn-send').getBoundingClientRect();return document.body.classList.contains('wy-keyboard-open')&&r.height<=60&&send.bottom<=445&&send.top>=0;}));
  await page.evaluate(()=>document.activeElement.blur());await page.waitForTimeout(50);
  check('输入失焦后键盘未收起时保持布局，避免发送按钮跳动',await page.evaluate(()=>document.body.classList.contains('wy-keyboard-open')));
  await page.evaluate(()=>window.__resizeKeyboard(844));
  await ask('帮我写一个网页');
  check('手机任务进度带角色，完成后可折叠查看步骤',await page.locator('.msg.agent').last().evaluate(el=>{const p=el.querySelector('.progress-card');return p&&!p.open&&p.querySelector('.pc-mascot')?.dataset.state==='happy'&&p.querySelectorAll('.pc-steps li').length>=2;}));
  await page.screenshot({path:path.join(OUT,'companion-mobile-chat.png')});
  await page.locator('.brand-mark').click();
  await page.getByRole('button',{name:'比个心',exact:true}).click();
  check('陪伴面板使用比心表情并放大角色',await page.locator('.wy-companion-stage .wy-mascot').evaluate(el=>el.dataset.state==='love'&&el.getBoundingClientRect().height>=250));
  await page.getByRole('button',{name:'摸摸头',exact:true}).click();
  check('点击摸头会回应，保持可爱的表情',await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')==='pet'&&/温柔/.test(await page.textContent('.wy-companion-say')));
  await page.screenshot({path:path.join(OUT,'companion-mobile-panel.png')});
  await page.getByRole('button',{name:'切换文字输入',exact:true}).click();await page.evaluate(()=>window.__resizeKeyboard(444));
  await page.screenshot({path:path.join(OUT,'companion-mobile-keyboard.png')});
  check('陪伴面板打字时缩小角色，输入和发送不被遮挡',await page.evaluate(()=>{const dialog=document.querySelector('.wy-companion'),input=dialog.querySelector('input'),r=input.getBoundingClientRect();return dialog.querySelector('.wy-mascot').getBoundingClientRect().height<=145&&r.top>=0&&r.bottom<=444&&!dialog.querySelector('form').hidden;}),JSON.stringify(await page.evaluate(()=>({keyboard:document.body.classList.contains('wy-keyboard-open'),input:document.querySelector('.wy-companion input').getBoundingClientRect().toJSON(),mascot:document.querySelector('.wy-companion-stage .wy-mascot').getBoundingClientRect().toJSON()}))));
  await page.fill('.wy-companion input','眨眨眼');await page.locator('.wy-companion form button').click();
  check('陪伴面板文字动作指令正常执行',await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')==='wink',await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state'));
  await page.getByRole('button',{name:'关闭未央',exact:true}).click();await page.evaluate(()=>window.__resizeKeyboard(844));
  await page.locator('.wy-composer-options>summary').click();await page.getByRole('button',{name:'选择模型与声音',exact:true}).click();
  check('更多选项仍可进入模型与声音设置',await page.isVisible('#llm-provider'));
  await page.click('#btn-side-back');
  await page.evaluate(base=>window.__jarvis.panels.patchConfig(c=>({...c,provider:'custom',models:{...c.models,custom:'ui-test'},keys:{...c.keys,custom:'sk-test'},baseURLs:{...c.baseURLs,custom:base+'/v1'},routing:{...c.routing,enabled:false}})),BASE);
  const before=await page.locator('.msg.agent').count();await page.fill('#prompt','请写一段较长的计划');await page.press('#prompt','Enter');
  await page.waitForFunction(n=>document.querySelectorAll('.msg.agent').length>n&&document.querySelector('.msg.agent:last-child .body')?.textContent.length>200,before);
  await page.evaluate(()=>{const root=document.getElementById('transcript');root.scrollTop=0;root.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>!document.querySelector('.msg.agent.streaming'),null,{timeout:30000});
  check('长回复自动收起大角色，让出阅读空间',await page.locator('.msg.agent').last().evaluate(el=>el.classList.contains('wy-long-reply')&&el.querySelector('.who .wy-mascot').getBoundingClientRect().height<=60));
  check('阅读旧消息时不会被流式输出拉回底部',await page.evaluate(()=>document.getElementById('transcript').scrollTop<80&&document.body.classList.contains('wy-reading-history')));
  await page.locator('.wy-jump-latest').click();
  check('可以一键回到最新回复',await page.evaluate(()=>{const r=document.getElementById('transcript');return r.scrollHeight-r.scrollTop-r.clientHeight<5;}));
  check('手机界面没有横向溢出和页面异常',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)&&errors.length===0,errors.join(' | '));
  await ctx.close();
  const safeContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await safeContext.addInitScript(()=>{if(window.top!==window)return;localStorage.setItem('jarvis.renderSafe','true');localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false}));});
  const safePage=await safeContext.newPage();const safeErrors=[];safePage.on('pageerror',e=>safeErrors.push(e.message));
  await safePage.goto(BASE);await safePage.waitForFunction(()=>window.__jarvis);
  await safePage.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('jarvis');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const now=Date.now(),messages=Array.from({length:60},(_,i)=>({role:i%2?'assistant':'user',content:`历史消息 ${i+1}：保留完整记录，按页显示。`,ts:now-60000+i}));
    await new Promise((resolve,reject)=>{const t=db.transaction('sessions','readwrite');t.objectStore('sessions').put({id:'render-health-history',title:'长对话稳定性',titleSet:true,createdAt:now-60000,updatedAt:now,pinned:false,messages});t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
  });
  await safePage.reload();await safePage.waitForFunction(()=>document.querySelectorAll('.msg').length===12);
  check('兼容模式启动即减少动画，只绘制最近 12 条历史',await safePage.evaluate(()=>document.documentElement.classList.contains('safe-render')&&getComputedStyle(document.querySelector('.msg .wy-mascot')).animationName==='none'&&document.querySelector('.msg.user .body').textContent.includes('历史消息 49')));
  await safePage.getByRole('button',{name:'查看更早的对话（还有 48 条）',exact:true}).click();
  check('向前翻页仍限制消息数量，可以读取较早内容',await safePage.evaluate(()=>document.querySelectorAll('.msg').length===12&&document.querySelector('.msg.user .body').textContent.includes('历史消息 37')));
  await safePage.getByRole('button',{name:'回到最近对话',exact:true}).click();
  await safePage.evaluate(()=>window.__jarvis.showPanel('settings'));
  check('手机提供可切换的兼容显示设置',await safePage.isVisible('#set-safe-render')&&await safePage.isChecked('#set-safe-render'));
  await safePage.uncheck('#set-safe-render');await safePage.waitForFunction(()=>!document.documentElement.classList.contains('safe-render')&&document.querySelectorAll('.msg').length===24);
  check('关闭兼容显示恢复标准分页，不重新加载页面',await safePage.evaluate(()=>document.querySelector('.msg.user .body').textContent.includes('历史消息 37')));
  await safePage.check('#set-safe-render');await safePage.waitForFunction(()=>document.querySelectorAll('.msg').length===12);
  await safePage.click('#btn-side-back');await safePage.locator('.brand-mark').click();await safePage.getByRole('button',{name:'眨眼睛',exact:true}).click();
  check('兼容显示仍可响应角色动作和文字按钮',await safePage.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')==='wink');
  await safePage.getByRole('button',{name:'关闭未央',exact:true}).click();
  check('分页和模式切换保留全部原始记录',await safePage.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('jarvis');r.onsuccess=()=>resolve(r.result);});
    const session=await new Promise(resolve=>{const r=db.transaction('sessions').objectStore('sessions').get('render-health-history');r.onsuccess=()=>resolve(r.result);});db.close();return session.messages.length===60&&session.messages[0].content.startsWith('历史消息 1：');
  }));
  await safePage.screenshot({path:path.join(OUT,'companion-mobile-safe-history.png')});
  check('兼容显示与历史翻页没有页面异常',safeErrors.length===0,safeErrors.join(' | '));
  await safeContext.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
console.log(`\n手机版陪伴界面 ${results.filter(Boolean).length}/${results.length} 通过`);if(results.some(x=>!x))process.exitCode=1;
