/** 实际手机构建：使用虚构静音WAV验证播放、歌词、安全、恢复与资源释放，不请求模型。 */
/** 渐变UI只接原页面：真实导航、窄屏、恢复及可读性；不请求模型。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const output = process.argv[2] || '/tmp/weiyang-song-card';
await fs.mkdir(output, { recursive: true });
const root = path.resolve('dist-mobile');
const server = http.createServer(async (req, res) => {
  try {
    const target = path.resolve(
      root,
      '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname)
    );
    if (!target.startsWith(root + path.sep)) throw Error('outside');
    const data = await fs.readFile(target);
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.wasm': 'application/wasm'
      }[path.extname(target)] || 'application/octet-stream'
    );
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

let checks=0;
try {
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
 await page.addInitScript(()=>localStorage.setItem('jarvis.settings.v1',JSON.stringify({theme:'day',speechOutput:false,autoMemory:false})));
 await page.goto(base);await page.waitForFunction(()=>window.__jarvis?.workspace);
 await page.evaluate(async()=>{
  const ws=window.__jarvis.workspace;
  const rate=8000,n=rate*8,bytes=new Uint8Array(44+n*2),v=new DataView(bytes.buffer);
  const str=(at,s)=>{for(let i=0;i<s.length;i++)bytes[at+i]=s.charCodeAt(i)};
  str(0,'RIFF');v.setUint32(4,36+n*2,true);str(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  for(const [path,title,lyrics] of [
   ['音乐/夜风.wav','夜风','[Verse]\n'+Array.from({length:24},(_,i)=>`[00:${String(Math.floor(i/2)).padStart(2,'0')}.${i%2?'50':'00'}]`+(i===0?'<img src=x onerror=window.songXSS=1>':`第${i+1}句歌词`)).join('\n')],
   ['音乐/原稿.wav','原稿',Array(24).fill('没有时间戳的歌词原稿').join('\n')]
  ]){
   await ws.write(path,new Blob([bytes],{type:'audio/wav'}));
   await ws.write('.workflows/music/'+encodeURIComponent(path)+'.json',JSON.stringify({version:1,path,title,lyrics,sha256:hash}));
  }
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('jarvis');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  await new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put({id:'song-fixture',title:'虚构歌曲回归',titleSet:true,createdAt:1,updatedAt:Date.now(),messages:[{role:'user',content:'生成测试歌曲',ts:1},{role:'assistant',content:'虚构音频与歌词测试。',ts:2,files:['音乐/夜风.wav','音乐/原稿.wav','音乐/缺失.wav']}]});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
  await window.__jarvis.openSession('song-fixture');
 });
 await page.waitForSelector('.song-card');
 assert.equal(await page.locator('.song-card').count(),3);checks++;
 const first=page.locator('.song-card').nth(0), second=page.locator('.song-card').nth(1);
 await first.locator('.song-head button').click();
 await page.waitForFunction(()=>document.querySelector('.song-card audio').currentTime>0);
 assert.ok(await first.locator('audio').evaluate(a=>a.duration>=7.9&&!a.paused));checks++;
 await first.locator('.song-head button').click();
 assert.ok(await first.locator('audio').evaluate(a=>a.paused));checks++;
 assert.equal(await first.locator('.song-lyrics p').count(),25);checks++;
 assert.equal(await first.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.songXSS),undefined);checks++;
 await first.locator('audio').evaluate(a=>{a.currentTime=1.2});
 await page.waitForFunction(()=>document.querySelector('.song-lyrics [aria-current]')?.textContent==='第3句歌词');checks++;
 const lyrics=first.locator('.song-lyrics');
 await lyrics.focus();await lyrics.press('Home');
 await page.waitForFunction(()=>document.querySelector('.song-lyrics').scrollTop===0);
 const outer=await page.locator('#transcript').evaluate(e=>e.scrollTop);
 const manual=await lyrics.evaluate(e=>e.scrollTop);
 await first.locator('audio').evaluate(a=>{a.currentTime=6.2});
 await page.waitForFunction(()=>document.querySelector('.song-lyrics [aria-current]')?.textContent==='第13句歌词');
 assert.equal(await lyrics.evaluate(e=>e.scrollTop),manual);assert.equal(await page.locator('#transcript').evaluate(e=>e.scrollTop),outer);checks++;
 await first.getByRole('button',{name:'跟随歌词',exact:true}).click();
 assert.ok(await lyrics.evaluate(e=>e.scrollTop>0));checks++;
 const [download]=await Promise.all([page.waitForEvent('download'),first.getByRole('button',{name:'下载音频',exact:true}).click()]);
 assert.equal(download.suggestedFilename(),'夜风.wav');assert.ok((await fs.stat(await download.path())).size>100000);checks++;
 await second.locator('.song-head button').click();await second.locator('audio').waitFor({state:'visible'});
 assert.equal(await second.getByRole('button',{name:'跟随歌词',exact:true}).isVisible(),false);assert.ok((await second.locator('.song-note').textContent()).includes('没有逐行时间戳'));checks++;
 assert.ok(await first.locator('audio').evaluate(a=>a.paused&&!a.hasAttribute('src')));checks++;
 await page.screenshot({path:path.join(output,'music-390.png')});
 await page.reload();await page.waitForFunction(()=>window.__jarvis?.openSession);await page.evaluate(()=>window.__jarvis.openSession('song-fixture'));await page.waitForSelector('.song-card');
 assert.equal(await page.locator('.song-card').count(),3);assert.ok(!(await page.evaluate(async()=>JSON.stringify(await window.__jarvis.sessionGet('song-fixture')))).includes('第24句歌词'));checks++;
 await page.locator('.song-card').nth(2).locator('.song-head button').click();
 await page.waitForFunction(()=>document.querySelectorAll('.song-note')[2]?.textContent.includes('未载入'));checks++;
 assert.equal(await page.locator('.file-link[data-path="音乐/缺失.wav"]').count(),1);checks++;
 await page.locator('.song-card').nth(0).locator('.song-head button').click();await page.waitForFunction(()=>document.querySelector('.song-card audio').currentTime>0);
 await page.evaluate(()=>{window.songPrevious=document.querySelector('.song-card audio');window.__jarvis.newSession()});
 await page.waitForFunction(()=>window.songPrevious.paused&&!window.songPrevious.hasAttribute('src'));checks++;
 console.log(`歌曲卡片：${checks}/${checks}，静音WAV夹具，无真实模型请求`);
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
