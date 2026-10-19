/** 真实Electron+真实HTTP模型桥+本机文件/输入；推理为可控测试模型，不消耗真实服务额度。 */
import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from '../server/server.mjs';
import {createServerMode,tokenFor} from '../server/serverMode.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-pc-e2e-')),home=path.join(temp,'home');fs.mkdirSync(home);
const out=process.argv[2]||temp;fs.mkdirSync(out,{recursive:true});
const pass='pc-e2e-only-password',dataDir=path.join(temp,'server');fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify({provider:'custom',models:{custom:'file-test'},keys:{custom:'FAKE_TEST_KEY'},routing:{enabled:true,provider:'custom',routes:{chat:'file-test',vision:'vision-test'}}}));
let app,fixture;const results=[],requests=[];
const check=(name,ok,detail='')=>{results.push(Boolean(ok));console.log(`${ok?'✓':'✗'} ${name}${detail?` — ${detail}`:''}`);};
const call=(name,args)=>({text:'',toolCalls:[{id:`test_${requests.length}`,name,args}],stop:'tool_use'});
const mode=createServerMode({dataDir,password:pass,makeModelAdapter:cfg=>({model:cfg.models[cfg.provider],adapter:{async stream(o){
  const q=[...o.messages].reverse().find(m=>m.role==='user')?.content||'';
  const last=[...o.messages].reverse().find(m=>m.role==='tool');requests.push({model:o.model,last:last?.name,tools:o.tools.map(t=>t.name),images:o.messages.filter(m=>m.images?.length).length});
  if(q.includes('天合云商')){
    if(!last)return call('computer_search',{keyword:'天合云商'});
    if(last.name==='computer_search'){
      const found=String(last.content).split('\n').find(s=>s.endsWith('天合云商2026年9月重点工作任务考核表-冷链.xlsx'));
      if(!found)throw Error('搜索未返回真实文件路径');return call('computer_open',{target:found});
    }
    o.onText('打开请求已提交，等待应用显示。');return{text:'打开请求已提交，等待应用显示。',toolCalls:[],stop:'end_turn'};
  }
  if(!last)return call('computer_look',{});
  if(last.name==='computer_look')return call('computer_type',{text:'PC测试文字'});
  if(last.name==='computer_type')return call('computer_key',{keys:'enter'});
  const value=await fixture.evaluate(()=>document.querySelector('textarea').value);
  if(!value.includes('PC测试文字'))throw Error('原生键盘未在测试窗口输入');
  o.onText('已输入并核对测试窗口。');return{text:'已输入并核对测试窗口。',toolCalls:[],stop:'end_turn'};
}}})});
const http=createServer({serverMode:mode,ollama:null});await new Promise(r=>http.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${http.address().port}`;
try{
  app=await electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/electron'),args:[path.join(root,'desktop'),'--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'],env:{...process.env,HOME:home,JARVIS_HOME:path.join(home,'.jarvis'),JARVIS_DESKTOP_TEST:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'1'}});
  const page=await app.firstWindow();await page.waitForSelector('#prompt',{timeout:60000});
  const paths=await page.evaluate(()=>window.jarvisDesktop.paths);
  if(!path.resolve(paths.home).startsWith(path.resolve(home)))throw Error('测试路径不是临时HOME，不操作真实用户文件');
  fs.mkdirSync(paths.documents,{recursive:true});const filename=path.join(paths.documents,'天合云商2026年9月重点工作任务考核表-冷链.xlsx');fs.writeFileSync(filename,'fixture');
  // 仅测试时拦截系统打开，验证真实IPC收到正确路径，不启动办公软件。
  await app.evaluate(({shell})=>{globalThis.__pcOpened=[];shell.openPath=async p=>{globalThis.__pcOpened.push(p);return'';};});
  await page.evaluate(({base,token})=>localStorage.setItem('jarvis.server.v1',JSON.stringify({url:base,token,enabled:true})),{base,token:tokenFor(pass)});await page.reload();await page.waitForFunction(()=>globalThis.__jarvisServerMode===true);
  const visibility=[];
  async function ask(q){
    await page.fill('#prompt',q);await page.press('#prompt','Enter');
    const deadline=Date.now()+60000;let started=false;
    while(Date.now()<deadline){
      const streaming=await page.locator('#transcript .msg.agent.streaming').count();if(streaming)started=true;
      const cards=page.locator('.confirm-card:not(.answered)');
      if(await cards.count()){
        visibility.push(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().startsWith('http://'));return Boolean(w?.isVisible()&&!w.isMinimized());}));
        await cards.first().getByRole('button',{name:'允许',exact:true}).click();
      }
      if(started&&!streaming)return await page.locator('#transcript .msg.agent').last().innerText();
      await page.waitForTimeout(80);
    }
    throw Error('PC控制对话未结束');
  }
  const answer=await ask('帮我打开天合云商2026年9月重点工作任务考核表-冷链 这个文档');
  const opened=await app.evaluate(()=>globalThis.__pcOpened);
  check('服务器模式+本机仍是演示配置：真实搜索并打开原话指定文档',opened.length===1&&opened[0]===filename,answer.slice(-70));
  check('本机搜索常驻，未另建服务器任务或要求上传',requests[0]?.tools.includes('computer_search')&&mode.runner.list().length===0&&!answer.includes('上传'));
  const fixtureId=await app.evaluate(async({BrowserWindow})=>{
    const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://'));
    const f=new BrowserWindow({width:700,height:400,x:80,y:80,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    await f.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>PC临时输入测试</title><textarea autofocus style="width:90vw;height:70vh"></textarea>'));
    main.on('hide',()=>{if(!f.isDestroyed()){f.show();f.focus();f.webContents.focus();}});main.show();main.focus();globalThis.__pcFixture=f;return f.id;
  });
  for(let n=0;n<100&&!fixture;n++){fixture=app.windows().find(p=>p!==page&&p.url().startsWith('data:'));if(!fixture)await page.waitForTimeout(50);}
  if(!fixture)throw Error(`未找到临时输入窗口 ${fixtureId}`);
  const before=requests.length;const gui=await ask('在当前窗口输入PC测试文字并按回车');
  const value=await fixture.evaluate(()=>document.querySelector('textarea').value);
  check('GUI请求使用服务器看图模型，并传递真实屏幕截图',requests.slice(before).every(r=>r.model==='vision-test')&&requests.slice(before).some(r=>r.images>0));
  check('真实剪贴板输入与快捷键到临时窗口',value.includes('PC测试文字')&&value.includes('\n'),gui.slice(-70));
  check('看屏后后续确认卡可见，结束后主窗口恢复',visibility.length>=3&&visibility.every(Boolean)&&await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://'))?.isVisible()));
  await page.screenshot({path:path.join(out,'pc-control.png')});
}catch(e){check('PC控制流程',false,e.stack||e.message);}
finally{if(app)await app.close();await mode.runner.settled();http.closeAllConnections();await new Promise(r=>http.close(r));fs.rmSync(temp,{recursive:true,force:true});}
console.log(`PC控制 ${results.filter(Boolean).length}/${results.length} 通过`);if(!results.length||results.some(x=>!x))process.exitCode=1;
