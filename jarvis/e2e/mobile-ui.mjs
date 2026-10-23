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
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:success=>{window.__weatherLocations=(window.__weatherLocations||0)+1;setTimeout(()=>success({coords:{latitude:31.234,longitude:121.474}}),30);}}});
    localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false}));
    const viewport=Object.assign(new EventTarget(),{height:844,width:390,offsetTop:0,offsetLeft:0,scale:1});
    Object.defineProperty(window,'visualViewport',{configurable:true,get:()=>viewport});
    window.__resizeKeyboard=height=>{viewport.height=height;viewport.dispatchEvent(new Event('resize'));};
  });
  let weatherOffline=false;
  await ctx.route('https://api.open-meteo.com/**',route=>{if(weatherOffline)return route.abort();const today=new Date(Date.now()+28800000).toISOString().slice(0,10),dates=[0,1,2].map(i=>new Date(Date.parse(today+'T00:00Z')+i*86400000).toISOString().slice(0,10));return route.fulfill({json:{utc_offset_seconds:28800,current:{temperature_2m:23,weather_code:2,is_day:1,time:today+'T18:00'},daily:{time:dates,temperature_2m_min:[17,18,19],temperature_2m_max:[24,25,26],weather_code:[2,61,0],precipitation_probability_max:[10,80,0]}}});});
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE);await page.waitForSelector('body.compact.companion-edition');
  await page.evaluate(()=>document.documentElement.classList.add('mobile-app'));
  await page.waitForFunction(()=>window.__jarvis&&document.querySelector('#app-splash')?.hidden!==false);await page.waitForTimeout(400);
  await page.waitForFunction(()=>document.querySelector('.home-city b')?.textContent.includes('23°'));
  check('首页自动定位城市、真实数据渲染，不需要手动选择',await page.evaluate(()=>window.__weatherLocations===1&&document.querySelector('.home-city b').textContent.includes('上海')));
  check('首页问候与未央不重叠，卡片不横向溢出',await page.evaluate(()=>{const h=document.querySelector('.home-hero-copy').getBoundingClientRect(),p=document.querySelector('.home-pet').getBoundingClientRect();return p.bottom<=h.top+1&&document.documentElement.scrollWidth<=innerWidth;}));
  check('首次首页从日期天气开始，顶部不会被自动滚动裁掉',await page.evaluate(()=>{const weather=document.querySelector('.home-weather').getBoundingClientRect(),header=document.querySelector('.topbar').getBoundingClientRect();return weather.top>=header.bottom-1&&document.querySelector('#transcript').scrollTop===0;}));
  // 新确认稿改为居中角色与参考字号，旧32px大标题和创作大卡片不再是验收目标。
  check('新确认稿居中角色、参考字号和三行建议完整呈现',await page.evaluate(()=>{const m=document.querySelector('.home-pet .wy-mascot').getBoundingClientRect(),h=document.querySelector('.home-hero h1');return m.width>=90&&m.width<=150&&Math.abs((m.left+m.right)/2-innerWidth/2)<6&&parseFloat(getComputedStyle(h).fontSize)<=17&&document.querySelectorAll('.home-suggestion').length===3&&document.querySelector('.home-footer')?.textContent.includes('内容由 AI 生成');}));
  check('390屏幕首屏显示文件空间，角色不贴屏幕右边',await page.evaluate(()=>{const files=document.querySelector('.home-files').getBoundingClientRect(),composer=document.querySelector('#inputbar').getBoundingClientRect(),mascot=document.querySelector('.home-pet .wy-mascot').getBoundingClientRect();return files.bottom<=composer.top-2&&mascot.right<=innerWidth-8;}));
  await page.locator('.toast').evaluateAll(nodes=>nodes.forEach(n=>{n.hidden=true;}));
  await page.screenshot({path:path.join(OUT,'mobile-weather-home.png')});
  check('未央用可朗读状态气泡招呼，角色保留轻浮动',await page.evaluate(()=>{const b=document.querySelector('.home-pet-hint'),m=document.querySelector('.home-pet .wy-mascot');return b.getAttribute('role')==='status'&&b.textContent.includes('我的头')&&getComputedStyle(m).animationName.includes('wy-float');}));
  await page.click('.home-pet');check('摸头切换角色表情',await page.locator('.home-pet .wy-mascot').getAttribute('data-state')==='pet');
  check('摸头后气泡变成未央本人的回应',await page.locator('.home-pet-hint').textContent().then(t=>t.includes('温柔')));
  await page.click('.home-weather-location');await page.waitForSelector('.weather-dialog[open]');
  check('右上角倒三角只打开位置选择，不混入天气详情',await page.isVisible('.weather-city-view')&&!(await page.isVisible('.weather-detail-view')));
  await page.click('.weather-close');
  await page.click('.home-weather-details');await page.waitForSelector('.weather-dialog[open]');
  check('点击天气图标打开详情，提供三日预报与降雨概率',await page.locator('.weather-day').count()===3&&(await page.locator('.weather-days').textContent()).includes('80%'));
  await page.screenshot({path:path.join(OUT,'mobile-weather-detail.png')});
  weatherOffline=true;await page.click('.weather-refresh');await page.waitForFunction(()=>document.querySelector('.home-weather-summary').textContent.includes('缓存'));
  check('断网保留天气并明确标记缓存',await page.locator('.weather-updated').textContent().then(t=>t.includes('缓存')));weatherOffline=false;
  await page.click('.weather-change');await page.click('.weather-city-result:has-text("杭州")');await page.waitForFunction(()=>document.querySelector('.home-city b').textContent.includes('杭州'));
  check('手动城市备用入口仍可用',await page.locator('.home-city b').textContent().then(t=>t.includes('杭州')));
  await page.setViewportSize({width:320,height:640});check('320窄屏首页不横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(OUT,'mobile-weather-home-narrow.png')});await page.setViewportSize({width:390,height:844});
  await page.click('.home-suggestions-head button');check('推荐可轮换而不重复天气入口',await page.locator('.home-suggestions').textContent().then(t=>t.includes('创作灵感')));
  await page.click('.home-start');check('创作卡片填写任务，继续复用原发送入口',await page.inputValue('#prompt').then(t=>t.includes('目标')));await page.fill('#prompt','');await page.locator('#prompt').blur();
  check('手机版实际产物启用陪伴感布局',await page.evaluate(()=>document.body.classList.contains('compact')&&!document.body.classList.contains('workbench')&&window.__jarvis.stage===null));
  check('手机浅蓝紫底色，保留清楚的未央图标',await page.evaluate(()=>{const r=document.querySelector('.brand-mark').getBoundingClientRect();return r.width>=44&&r.height>=44&&getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#eef0ff';}));
  check('手机空白输入栏显示＋、模型、转文字和电话，发送收起',await page.evaluate(()=>['btn-attach','model-chip','btn-mic','btn-call'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>=32&&r.height>=36;})&&document.getElementById('btn-send').hidden));
  await page.click('#btn-attach');
  check('拍照、相册、文件和常用指令收在＋菜单中',await page.isVisible('#composer-more')&&await page.isVisible('#btn-camera')&&await page.isVisible('#btn-composer-file'));
  await page.click('#btn-attach');
  check('顶栏图标完整位于栏内，与文字保持间距',await page.evaluate(()=>{const header=document.querySelector('.topbar').getBoundingClientRect(),logo=document.querySelector('.brand-mark .wy-mascot').getBoundingClientRect(),name=document.querySelector('.brand-name').getBoundingClientRect();return logo.top>=header.top&&logo.bottom<=header.bottom&&logo.right+6<=name.left&&Math.abs((logo.top+logo.bottom)/2-(name.top+name.bottom)/2)<8;}));
  check('顶栏与页面使用同一底色',await page.evaluate(()=>getComputedStyle(document.querySelector('.topbar')).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(document.body).backgroundImage.includes('gradient')));
  await page.evaluate(()=>window.__jarvis.showPanel('mind'));
  check('记忆面板和返回栏使用同一套新主题',await page.evaluate(()=>getComputedStyle(document.querySelector('.side')).backgroundImage.includes('gradient')&&getComputedStyle(document.querySelector('.side-back')).backgroundColor==='rgb(238, 240, 255)'));
  await page.click('#btn-theme');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  check('夜间顶栏和面板同步切换，不出现白色顶栏',await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#191b2b'&&getComputedStyle(document.querySelector('.side')).backgroundImage.includes('gradient')&&getComputedStyle(document.querySelector('.topbar')).backgroundColor==='rgba(0, 0, 0, 0)'));
  await page.screenshot({path:path.join(OUT,'mobile-unified-dark-panel.png')});
  await page.click('#btn-theme');await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.click('#btn-side-back');
  async function ask(text){const before=await page.locator('.msg.agent').count();await page.fill('#prompt',text);await page.click('#btn-send');await page.waitForFunction(n=>document.querySelectorAll('.msg.agent').length>n&&!document.querySelector('.msg.agent.streaming'),before,{timeout:30000});await page.waitForTimeout(120);}
  // 手机键盘回车是换行，点发送按钮才发
  await page.fill('#prompt','第一行');await page.press('#prompt','Enter');
  check('手机上回车换行，不会直接发出去',await page.inputValue('#prompt').then(t=>t.includes('\n'))&&await page.locator('.msg.user').count()===0);
  await page.fill('#prompt','');
  await ask('你好');
  check('每条消息下面有复制、引用，未央的回答还有朗读',await page.locator('.msg.user').last().locator('.msg-copy, .msg-quote').count()===2&&await page.locator('.msg.agent').last().locator('.msg-copy, .msg-quote, .msg-speak').count()===3);
  await page.locator('.msg.agent').last().locator('.msg-quote').click();
  check('点“引用”把这条的开头放进输入框',await page.inputValue('#prompt').then(t=>/^> .+\n$/.test(t)));
  await page.fill('#prompt','');
  const usersBefore=await page.locator('.msg.user').count();
  await page.locator('.msg.agent').last().locator('.msg-retry').click();
  await page.waitForFunction(n=>document.querySelectorAll('.msg.user').length===n&&document.querySelectorAll('.msg.agent').length>0&&!document.querySelector('.msg.agent.streaming'),usersBefore,{timeout:20000}).catch(()=>{});
  check('重新生成：同一句话重新问一次，不多出消息',await page.locator('.msg.user').count()===usersBefore&&await page.locator('.msg.agent').count()===usersBefore);
  check('消息按钮是图标（带文字说明）',await page.locator('.msg.agent').last().locator('.msg-copy svg').count()===1&&await page.locator('.msg.agent').last().locator('.msg-copy').getAttribute('aria-label')==='复制');
  check('顶栏显示当前对话的标题',await page.evaluate(()=>{const t=document.getElementById('chat-title');return !t.hidden&&t.textContent.includes('你好')&&t.getBoundingClientRect().height>0;}));
  check('对话正文两侧保留至少 20px 阅读留白',await page.locator('.msg.agent').last().evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=20&&r.right<=innerWidth-20;}));
  check('手机完成后的短回复使用紧凑单头像，不留大块空白或固定的话',await page.locator('.msg.agent').last().evaluate(el=>{const who=el.querySelector('.who');return who.querySelectorAll('.wy-mascot').length===1&&who.querySelector('.wy-mascot').getBoundingClientRect().height>=30&&who.querySelector('.wy-mascot').getBoundingClientRect().height<=36&&!who.querySelector('.wy-reply-greeting');}));
  check('手机消息角色不遮昵称，正文在标题下方且没有横向溢出',await page.locator('.msg.agent').last().evaluate(el=>{const r=x=>x.getBoundingClientRect(),head=r(el.querySelector('.who')),avatar=r(el.querySelector('.who-mood')),name=r(el.querySelector('.who-name')),body=r(el.querySelector('.body'));return avatar.right<=name.left+1&&head.bottom<=body.top+1&&body.left>=20&&body.right<=innerWidth-20&&document.querySelector('#transcript').scrollWidth<=document.querySelector('#transcript').clientWidth+1;}));
  await page.fill('#prompt','需要补充的要求');await page.focus('#prompt');await page.evaluate(()=>window.__resizeKeyboard(444));await page.waitForTimeout(80);
  check('键盘弹出时角色缩小且发送按钮保持可见',await page.evaluate(()=>{const r=document.querySelector('.msg.agent:last-child .who .wy-mascot').getBoundingClientRect(),send=document.getElementById('btn-send').getBoundingClientRect();return document.body.classList.contains('wy-keyboard-open')&&r.height<=60&&send.bottom<=445&&send.top>=0;}));
  await page.evaluate(()=>document.activeElement.blur());await page.waitForTimeout(50);
  check('输入失焦后键盘未收起时保持布局，避免发送按钮跳动',await page.evaluate(()=>document.body.classList.contains('wy-keyboard-open')));
  await page.fill('#prompt','');
  await page.evaluate(()=>window.__resizeKeyboard(844));
  await ask('帮我写一个网页');
  check('手机任务进度带角色，完成后可折叠查看步骤',await page.locator('.msg.agent').last().evaluate(el=>{const p=el.querySelector('.progress-card');return p&&!p.open&&p.querySelector('.pc-mascot')?.dataset.state==='happy'&&p.querySelectorAll('.pc-steps li').length>=2;}));
  await page.screenshot({path:path.join(OUT,'companion-mobile-chat.png')});
  await page.locator('.brand-mark').click();
  await page.getByRole('button',{name:'比个心',exact:true}).click();
  check('陪伴面板使用比心表情并放大角色',await page.locator('.wy-companion-stage .wy-mascot').evaluate(el=>el.dataset.state==='love'&&el.getBoundingClientRect().height>=170&&el.getBoundingClientRect().top>=document.querySelector('.wy-companion-title').getBoundingClientRect().bottom+4));
  check('陪伴角色不遮挡标题文字',await page.locator('.wy-companion-stage .wy-mascot').evaluate(el=>{const r=el.getBoundingClientRect(),title=document.querySelector('.wy-companion-title').getBoundingClientRect(),stage=el.parentElement.getBoundingClientRect();return title.bottom+4<=r.top&&r.top>=stage.top-4&&r.height<=stage.height;}));
  await page.getByRole('button',{name:'摸摸头',exact:true}).click();
  check('点击摸头会回应，保持可爱的表情',await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')==='pet'&&/温柔/.test(await page.textContent('.wy-companion-say')));
  await page.screenshot({path:path.join(OUT,'companion-mobile-panel.png')});
  await page.getByRole('button',{name:'切换文字输入',exact:true}).click();await page.evaluate(()=>window.__resizeKeyboard(444));
  await page.screenshot({path:path.join(OUT,'companion-mobile-keyboard.png')});
  check('陪伴面板打字时缩小角色，输入和发送不被遮挡',await page.evaluate(()=>{const dialog=document.querySelector('.wy-companion'),input=dialog.querySelector('input'),r=input.getBoundingClientRect();return dialog.querySelector('.wy-mascot').getBoundingClientRect().height<=145&&r.top>=0&&r.bottom<=444&&!dialog.querySelector('form').hidden;}),JSON.stringify(await page.evaluate(()=>({keyboard:document.body.classList.contains('wy-keyboard-open'),input:document.querySelector('.wy-companion input').getBoundingClientRect().toJSON(),mascot:document.querySelector('.wy-companion-stage .wy-mascot').getBoundingClientRect().toJSON()}))));
  await page.fill('.wy-companion input','眨眨眼');await page.locator('.wy-companion form button').click();
  check('陪伴面板文字动作指令正常执行',await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')==='wink',await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state'));
  await page.getByRole('button',{name:'关闭未央',exact:true}).click();await page.evaluate(()=>window.__resizeKeyboard(844));
  check('移除底部声音跳转入口，显示当前模型',await page.isVisible('#model-chip')&&await page.locator('.wy-composer-options').count()===0);
  await page.evaluate(base=>window.__jarvis.panels.patchConfig(c=>({...c,provider:'custom',models:{...c.models,custom:'ui-test-a'},keys:{...c.keys,custom:'sk-test'},baseURLs:{...c.baseURLs,custom:base+'/v1'},modelLists:{...c.modelLists,['custom|'+base+'/v1']:{ids:['ui-test-a','ui-test-b'],at:Date.now()}},favoriteModels:[{provider:'custom',model:'ui-test-b'}],routing:{...c.routing,enabled:false}})),BASE);
  await page.click('#model-chip');
  check('当前模型直接展开常用模型底部面板，无页面跳转',await page.evaluate(()=>{const sheet=document.querySelector('.ml-picker'),r=sheet.getBoundingClientRect();return !sheet.hidden&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight+1&&!document.body.classList.contains('side-open')&&sheet.textContent.includes('自定义');}));
  await page.locator('.ml-picker-item').filter({has:page.getByText('ui-test-b',{exact:true})}).click();
  check('点选后直接换模型并更新输入框标签',await page.evaluate(()=>window.__jarvis.config.models.custom==='ui-test-b'&&document.getElementById('model-chip-text').textContent==='本机 · ui-test-b'&&document.querySelector('.ml-picker').hidden&&!document.body.classList.contains('side-open')));
  const before=await page.locator('.msg.agent').count();await page.fill('#prompt','请写一段较长的计划');await page.click('#btn-send');
  await page.waitForFunction(n=>document.querySelectorAll('.msg.agent').length>n&&document.querySelector('.msg.agent:last-child .body')?.textContent.length>200,before);
  await page.evaluate(()=>{const root=document.getElementById('transcript');root.scrollTop=0;root.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>!document.querySelector('.msg.agent.streaming'),null,{timeout:30000});
  check('长回复自动收起大角色，让出阅读空间',await page.locator('.msg.agent').last().evaluate(el=>el.classList.contains('wy-long-reply')&&el.querySelector('.who .wy-mascot').getBoundingClientRect().height<=60));
  check('阅读旧消息时不会被流式输出拉回底部',await page.evaluate(()=>document.getElementById('transcript').scrollTop<80&&document.body.classList.contains('wy-reading-history')));
  await page.locator('.wy-jump-latest').click();
  check('可以一键回到最新回复',await page.evaluate(()=>{const r=document.getElementById('transcript');return r.scrollHeight-r.scrollTop-r.clientHeight<5;}));
  await page.locator('.brand-mark').click();await page.locator('.wy-hologram-entry').click();
  check('手机全息陪伴填满屏幕，没有横向溢出',await page.locator('.holo-dialog').evaluate(d=>{const r=d.getBoundingClientRect();return d.open&&r.left===0&&r.width===innerWidth&&Math.abs(r.height-844)<2&&d.scrollWidth<=innerWidth;}));
  await page.locator('.holo-pet').click();
  check('全息角色摸头有表情和光圈回应',await page.locator('.holo-pet .wy-mascot').getAttribute('data-state')==='pet'&&/开心/.test(await page.locator('.holo-bubble').textContent()));
  await page.locator('[data-pose=love]').click();
  check('全息角色比心使用最新角色素材',await page.locator('.holo-pet .wy-mascot').evaluate(el=>el.dataset.state==='love'&&getComputedStyle(el).backgroundImage.includes('mascot-approved')));
  await page.screenshot({path:path.join(OUT,'hologram-mobile.png')});
  await page.locator('.holo-form input').fill('请帮我整理今天的计划');await page.locator('.holo-form button').click();
  await page.waitForFunction(()=>document.querySelector('.holo-message.assistant')?.textContent.includes('第 1 项')&&!document.querySelector('.holo-form button').disabled);
  check('全息文字对话收到模型回复，并写入完整对话记录',await page.locator('.holo-message.assistant').last().textContent()===await page.locator('#transcript .msg.agent').last().locator('.body').textContent());
  await page.locator('.holo-form input').focus();await page.evaluate(()=>window.__resizeKeyboard(444));
  check('全息陪伴键盘出现后让出空间，输入和发送可见',await page.evaluate(()=>{const root=document.querySelector('.holo-dialog'),input=root.querySelector('input').getBoundingClientRect(),send=root.querySelector('.holo-form button').getBoundingClientRect();return root.querySelector('.holo-pet .wy-mascot').getBoundingClientRect().height<=80&&input.top>=0&&send.bottom<=444;}));
  await page.screenshot({path:path.join(OUT,'hologram-mobile-keyboard.png')});
  await page.locator('.holo-full').click();await page.evaluate(()=>window.__resizeKeyboard(844));
  // 对话框的 close 事件是异步派发的：等它处理完再检查，避免 CI 机器忙时偶发失败
  await page.waitForFunction(()=>!document.querySelector('.holo-dialog').open&&document.querySelector('.wy-hologram')?.classList.contains('holo-paused'),null,{timeout:5000}).catch(()=>{});
  check('打开完整对话正常返回，未央全息场景暂停动画',!await page.locator('.holo-dialog').evaluate(d=>d.open)&&await page.locator('.wy-hologram').evaluate(el=>el.classList.contains('holo-paused')));
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
  // 翻到旧的一页后停在这页底部：底部要有接着往后看的按钮（以前只在顶上，往下滑就像卡住）
  check('旧的一页滑到底能接着往后看',await safePage.evaluate(()=>{const r=document.getElementById('transcript'),b=[...r.querySelectorAll('.wy-history-pages button')].find(x=>x.textContent.startsWith('继续往后看'));if(!b)return false;const br=b.getBoundingClientRect(),rr=r.getBoundingClientRect();return br.top<rr.bottom&&br.bottom>rr.top&&b.textContent.includes('还有 12 条');}));
  await safePage.getByRole('button',{name:/继续往后看/}).click();
  check('接着往后看从下一页开头读起',await safePage.evaluate(()=>{const r=document.getElementById('transcript');return r.scrollTop<40&&document.querySelectorAll('.msg').length===12&&document.querySelector('.msg.user .body').textContent.includes('历史消息 49');}));
  await safePage.getByRole('button',{name:'查看更早的对话（还有 48 条）',exact:true}).click();
  await safePage.getByRole('button',{name:'回到最近对话',exact:true}).first().click();
  await safePage.evaluate(()=>window.__jarvis.showPanel('settings'));
  check('手机可复制包含运行规模的异常诊断',await safePage.isVisible('#btn-copy-render-diagnostics'));
  check('兼容模式关掉图片遮罩（启动页扫光、首页插画淡出）',await safePage.evaluate(()=>{const el=document.createElement('i');el.className='home-task-icon';document.body.append(el);const m=getComputedStyle(el);const off=(m.maskImage||m.webkitMaskImage||'none')==='none';el.remove();return off;}));
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
  // 从后台关掉再打开：回首页、不再弹定位；历史对话默认只列 8 条
  const relaunch=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await relaunch.addInitScript(()=>{if(window.top!==window)return;Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:success=>{window.__weatherLocations=(window.__weatherLocations||0)+1;setTimeout(()=>success({coords:{latitude:31.234,longitude:121.474}}),30);}}});localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false}));});
  await relaunch.route('https://api.open-meteo.com/**',route=>route.abort());
  const again=await relaunch.newPage(),againErrors=[];again.on('pageerror',e=>againErrors.push(e.message));
  await again.goto(BASE);await again.waitForFunction(()=>window.__jarvis&&window.__weatherLocations===1);
  await again.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('jarvis');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const now=Date.now();await new Promise((resolve,reject)=>{const t=db.transaction('sessions','readwrite');for(let i=0;i<12;i++)t.objectStore('sessions').put({id:`relaunch-${i}`,title:`历史对话 ${i+1}`,titleSet:true,createdAt:now-i*60000,updatedAt:now-i*60000,pinned:false,messages:[{role:'user',content:`第 ${i+1} 段`,ts:now-i*60000}]});t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
  });
  await again.goto(BASE);await again.waitForFunction(()=>window.__jarvis&&document.querySelector('.wy-home'));await again.waitForTimeout(800);
  check('从后台关掉再打开停在首页，不自动打开上次的对话',await again.evaluate(()=>!document.querySelector('#transcript .msg')&&Boolean(document.querySelector('.wy-home'))));
  check('再次打开用记住的城市，不再弹定位确认',await again.evaluate(()=>!window.__weatherLocations&&document.querySelector('.home-city b').textContent.includes('上海')));
  await again.click('#btn-menu');await again.waitForSelector('.drawer-item');
  check('历史对话默认只列 8 条，其余收在“展开更多”里',await again.locator('.drawer-item').count()===8&&(await again.locator('.drawer-more').textContent()).includes('还有 4 条'));
  await again.click('.drawer-more');await again.waitForFunction(()=>document.querySelectorAll('.drawer-item').length===12);
  await again.click('.drawer-more.inline');await again.waitForFunction(()=>document.querySelectorAll('.drawer-item').length===8);
  await again.evaluate(()=>localStorage.setItem('jarvis.pendingTasks.v1',JSON.stringify({'relaunch-3':{turnId:1,text:'生成一页纸汇报 Word',title:'历史对话 4',ts:Date.now()-60000,steps:['读取文件'],files:[]}})));
  await again.goto(BASE);await again.waitForFunction(()=>[...document.querySelectorAll('#transcript .msg.user')].some(m=>m.textContent.includes('上次 App 被关掉')),null,{timeout:15000});
  check('App 被关掉时没做完的任务：再打开回到那个对话，带着做过的步骤接着做',await again.evaluate(()=>document.querySelector('#transcript').textContent.includes('第 4 段')&&[...document.querySelectorAll('#transcript .msg.user')].at(-1).textContent.includes('已经做过的步骤：读取文件')));
  check('展开后能看到全部、也能收起，没有页面异常',againErrors.length===0,againErrors.join(' | '));
  await relaunch.close();

  // 百炼实时语音：使用模拟的原生WSS服务，真实WebAudio采集/播放；不调用收费接口。
  {
    const qctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await qctx.addInitScript(()=>{
      localStorage.setItem('jarvis.llm.v1',JSON.stringify({provider:'mock',keys:{qwen:'test-only-key'},voice:{engine:'qwen-realtime',voices:{'qwen-realtime':'Bella'},fx:'none',cues:false,qwenRegion:'beijing'},stt:{engine:'qwen-realtime'}}));
      localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false}));
      const listeners=new Set(),sessions=new Map();window.__qwenModels=[];window.__qwenClosed=[];window.__qwenFrames=0;
      const emit=e=>{for(const fn of listeners)fn(e);};
      window.__jarvisQwenSocket={
        addListener:async(name,fn)=>{listeners.add(fn);return{remove:()=>listeners.delete(fn)};},
        connect:async({id,model})=>{sessions.set(id,model);window.__qwenModels.push(model);},
        send:async({id,data})=>{
          const e=JSON.parse(data),model=sessions.get(id);
          if(e.type==='session.update')queueMicrotask(()=>emit({id,phase:'message',data:JSON.stringify({type:'session.updated'})}));
          if(model==='qwen3-asr-flash-realtime'&&e.type==='input_audio_buffer.append'){
            window.__qwenFrames++;
            if(!window.__qwenSubmitted){window.__qwenSubmitted=true;queueMicrotask(()=>{
              for(const event of [{type:'input_audio_buffer.speech_started'},{type:'conversation.item.input_audio_transcription.text',text:'你好',stash:'未央'},{type:'conversation.item.input_audio_transcription.completed',item_id:'test-one',transcript:'你好，未央'}])emit({id,phase:'message',data:JSON.stringify(event)});
            });}
          }
          if(model==='qwen3-tts-flash-realtime'&&e.type==='session.finish'){
            queueMicrotask(()=>emit({id,phase:'message',data:JSON.stringify({type:'response.audio.delta',delta:btoa('\0'.repeat(4800))})}));
            setTimeout(()=>emit({id,phase:'message',data:JSON.stringify({type:'session.finished'})}),2000);
          }
        },
        close:async({id})=>{sessions.delete(id);window.__qwenClosed.push(id);}
      };
      navigator.mediaDevices.getUserMedia=async()=>{
        const ctx=new AudioContext(),osc=ctx.createOscillator(),gain=ctx.createGain(),dest=ctx.createMediaStreamDestination();
        gain.gain.value=0;osc.connect(gain);gain.connect(dest);osc.start();await ctx.resume();
        window.__qwenMicTracks=dest.stream.getTracks();return dest.stream;
      };
    });
    const qp=await qctx.newPage();
    await qp.goto(BASE);await qp.waitForFunction(()=>window.__jarvis?.send);
    await qp.click('#btn-mic');
    await qp.waitForFunction(()=>document.querySelector('#prompt').value.includes('你好，未央')&&window.__jarvis.voice.mode==='off',null,{timeout:15000});
    check('麦克风只转文字到输入框，不自动发消息、不启动朗读',await qp.evaluate(()=>document.querySelectorAll('#transcript .msg.user').length===0&&!window.__qwenModels.includes('qwen3-tts-flash-realtime')));
    await qp.fill('#prompt','');await qp.evaluate(()=>{window.__qwenSubmitted=false;});
    await qp.click('#btn-call');
    await qp.waitForFunction(()=>window.__qwenFrames>0&&document.querySelector('#transcript .msg.user')?.textContent.includes('你好，未央'),null,{timeout:15000});
    check('百炼实时ASR收音后提交最终文字，使用指定实时模型',await qp.evaluate(()=>window.__qwenModels.includes('qwen3-asr-flash-realtime')&&document.querySelectorAll('#transcript .msg.user').length===1));
    await qp.waitForFunction(()=>window.__qwenModels.includes('qwen3-tts-flash-realtime')&&window.__jarvis.speaker.source,null,{timeout:15000});
    check('百炼实时TTS收到PCM即播放，不走audio/speech假接口',await qp.evaluate(()=>window.__jarvis.speaker.speaking&&Boolean(window.__jarvis.speaker.source)));
    await qp.evaluate(()=>{window.__jarvisForeground=false;dispatchEvent(new CustomEvent('jarvis:foreground',{detail:{active:false}}));});
    await qp.waitForFunction(()=>window.__jarvis.voice.mode==='off'&&!window.__jarvis.speaker.speaking);
    check('切换其他App停止百炼录音、流式音频与实时连接',await qp.evaluate(()=>window.__qwenMicTracks.every(t=>t.readyState==='ended')&&!window.__jarvis.speaker.source&&window.__qwenClosed.length>=2));
    await qctx.close();
  }

  for(const width of [320,360,390,412]){
    const narrow=await browser.newPage({viewport:{width,height:780}});await narrow.goto(BASE);await narrow.waitForSelector('body.companion-edition');
    await narrow.waitForFunction(()=>window.__jarvis?.send);await narrow.evaluate(()=>{document.documentElement.style.fontSize='18px';document.getElementById('model-chip-text').textContent='服务器 · claude-sonnet-very-long-model-name';});
    check(`${width}px 手机空白输入区保持同排、不溢出`,await narrow.evaluate(()=>{const r=id=>document.getElementById(id).getBoundingClientRect(),model=r('model-chip'),mic=r('btn-mic'),call=r('btn-call');return document.documentElement.scrollWidth<=innerWidth&&model.width>=50&&model.right<=innerWidth-12&&Math.abs(model.top-mic.top)<=3&&model.right<=mic.left&&mic.right<=call.left&&Math.abs(mic.top-call.top)<=3&&document.getElementById('btn-send').hidden;}));
    await narrow.fill('#prompt','生成中继续补充要求');await narrow.evaluate(()=>document.body.classList.add('generating'));
    await narrow.waitForFunction(()=>document.getElementById('inputbar').classList.contains('is-working'));
    check(`${width}px 生成中发送和停止同时可用、不挤到下一行`,await narrow.evaluate(()=>{const r=id=>document.getElementById(id).getBoundingClientRect(),stop=r('btn-stop'),send=r('btn-send'),model=r('model-chip');return stop.width>=36&&send.width>=36&&Math.abs(stop.top-send.top)<=3&&Math.abs(model.top-stop.top)<=3&&model.right<=stop.left&&model.right<=innerWidth-12&&stop.right<=send.left&&send.right<=innerWidth-12&&!document.getElementById('btn-send').disabled;}));
    await narrow.evaluate(()=>document.body.classList.remove('generating'));await narrow.fill('#prompt','');
    await narrow.screenshot({path:path.join(OUT,`mobile-unified-${width}.png`)});await narrow.close();
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
console.log(`\n手机版陪伴界面 ${results.filter(Boolean).length}/${results.length} 通过`);if(results.some(x=>!x))process.exitCode=1;
