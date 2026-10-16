/** 真正启动 Electron，验证背景/透明窗口分离、受限桥接和跨窗口对话。 */
import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=process.argv[2]||'.',home=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-holo-'));
fs.mkdirSync(out,{recursive:true});const results=[];const check=(label,ok)=>{results.push(ok);console.log(`${ok?'✓':'✗'} ${label}`);};
let app;
try{
  app=await electron.launch({executablePath:path.join(root,'desktop/node_modules/electron/dist/electron'),args:[path.join(root,'desktop'),'--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'],env:{...process.env,HOME:home,JARVIS_HOME:path.join(home,'.jarvis'),JARVIS_DESKTOP_TEST:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'1'}});
  const main=await app.firstWindow();await main.waitForFunction(()=>window.__jarvis,null,{timeout:60000});
  const errors=[];main.on('pageerror',e=>errors.push(e.message));
  await main.evaluate(()=>{window.__jarvis.speaker.enabled=false;return window.jarvisDesktop.invoke('setWallpaper',{on:true});});
  await main.waitForTimeout(1500);
  const background=app.windows().find(w=>w.url().includes('wallpaper.html')&&!w.url().includes('widget=1')),widget=app.windows().find(w=>w.url().includes('widget=1'));
  await background.waitForFunction(()=>window.__wallpaper);await widget.waitForSelector('.holo-pet');widget.on('pageerror',e=>errors.push(e.message));
  check('静态桌面背景与透明互动窗口分别创建',!!background&&!!widget);
  check('背景不抢焦点、角色不强制置顶',await app.evaluate(({BrowserWindow})=>{const rows=BrowserWindow.getAllWindows();const bg=rows.find(w=>/wallpaper.html$/.test(w.webContents.getURL())),pet=rows.find(w=>w.webContents.getURL().includes('widget=1'));return !bg.isFocusable()&&!pet.isAlwaysOnTop();}));
  check('陪伴页面拿不到 Node，背景不启动 WebGL',await widget.evaluate(()=>typeof require==='undefined'&&typeof process==='undefined')&&await background.evaluate(()=>!document.querySelector('canvas')));
  check('主窗口不能伪造角色点击区域',await main.evaluate(()=>window.jarvisDesktop.invoke('wallpaperRegions',{regions:[]}).then(()=>false,e=>/仅陪伴/.test(e.message))));
  await widget.locator('.holo-pet').click();await widget.locator('.holo-pet').click();await widget.locator('.holo-pet').click();
  check('真实 Electron 角色接受摸头并变害羞',await widget.locator('.holo-pet .wy-mascot').getAttribute('data-state')==='shy');
  await widget.locator('.holo-form input').fill('你好');await widget.locator('.holo-form button').click();
  await widget.waitForFunction(()=>document.querySelector('.holo-message.assistant')&&!document.querySelector('.holo-form button').disabled,null,{timeout:45000});
  check('桌面输入交给主智能体并同步模型回复',(await widget.locator('.holo-message.assistant').last().textContent()).length>2&&(await main.locator('#transcript .msg.user').last().textContent()).includes('你好'));
  await main.evaluate(()=>window.jarvisDesktop.invoke('wallpaperScale',{scale:0.75}));
  await widget.waitForFunction(()=>document.querySelector('.wy-hologram').style.getPropertyValue('--holo-widget-scale')==='0.75');
  check('角色大小可调',await widget.locator('.holo-pet .wy-mascot').evaluate(el=>el.getBoundingClientRect().height<200));
  await background.screenshot({path:path.join(out,'hologram-desktop-background.png')});await widget.screenshot({path:path.join(out,'hologram-desktop-widget.png'),omitBackground:true});
  await widget.locator('.holo-full').click();await main.waitForFunction(()=>document.querySelector('.holo-dialog')?.open);
  check('完整对话入口呼出主窗口全息场景',await main.locator('.holo-dialog').evaluate(d=>d.open));
  await main.evaluate(()=>window.jarvisDesktop.invoke('setWallpaper',{on:false}));
  check('关闭桌面模式同时清理两个窗口',await app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('wallpaper.html'))));
  check('主窗口和陪伴窗口没有页面错误',errors.length===0);if(errors.length)console.log(errors.join('\n'));
}finally{await app?.close();fs.rmSync(home,{recursive:true,force:true});}
console.log(`${results.filter(Boolean).length}/${results.length} 全息桌面通过`);process.exit(results.every(Boolean)?0:1);
