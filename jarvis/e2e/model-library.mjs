/** 使用本机假服务商与真正服务器模式，检查配置隔离和几百个模型的实际界面。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const output=process.argv[2]||path.join(os.tmpdir(),'jarvis-model-library');
fs.mkdirSync(output,{recursive:true});
const data=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-model-library-data-'));
const password='library-test-password';
const token=createHash('sha256').update(`jarvis-server:${password}`).digest('hex');
const port=8794;
const base=`http://127.0.0.1:${port}`;
const results=[];
const check=(title,ok)=>{results.push(ok);console.log(`${ok?'✓':'✗'} ${title}`);};
const requests=[];
const upstream=createServer((req,res)=>{
  requests.push({path:req.url,key:req.headers.authorization});
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({data:[{id:'shared-model'},...Array.from({length:300},(_,i)=>({id:`chat-model-${i}`})),{id:'gpt-image-2'}]}));
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const address=`http://127.0.0.1:${upstream.address().port}/v1`;
const serverConfig={provider:'custom',models:{custom:'shared-model','relay-2':'shared-model'},keys:{custom:'server-key-secret','relay-2':'backup-secret'},baseURLs:{custom:address,'relay-2':address},providerNames:{custom:'供应商 A','relay-2':'供应商 B'},favoriteModels:[{provider:'relay-2',model:'shared-model'}]};
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(serverConfig));
const gateway=spawn(process.execPath,['server/server.mjs'],{env:{...process.env,PORT:String(port),JARVIS_DATA:data,JARVIS_PASSWORD:password},stdio:'pipe'});
let logs='';
gateway.stdout.on('data',chunk=>{logs+=chunk;});
gateway.stderr.on('data',chunk=>{logs+=chunk;});
const browser=await chromium.launch();
try {
  for(let i=0;i<100;i++){
    try {if((await fetch(base+'/api/health')).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900}});
    const errors=[];
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({base,token,address})=>{
      localStorage.setItem('jarvis.server.v1',JSON.stringify({url:base,token,enabled:true}));
      localStorage.setItem('jarvis.llm.v1',JSON.stringify({provider:'custom',models:{custom:'local-model'},keys:{custom:'local-key-secret'},baseURLs:{custom:address}}));
    },{base,token,address});
    await page.goto(base);
    await page.waitForFunction(()=>window.__jarvis?.showPanel);
    await page.evaluate(()=>window.__jarvis.showPanel('models'));
    await page.waitForSelector('.ml-provider');
    check(`${width} 配置位置默认云服务器，按服务商显示`,await page.locator('#model-workspace .ml-scope-note').textContent()==='正在修改服务器配置，不影响本机'&&await page.locator('.ml-provider').count()===2);
    const card=()=>page.locator('.ml-provider').filter({has:page.getByText('供应商 A',{exact:true})});
    await card().getByRole('button',{name:'拉取模型',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ml-notice')?.textContent.includes('已拉取 302'));
    check(`${width} 几百个模型分批展示，不全铺开`,await page.locator('.ml-catalog-results [data-model]').count()===12);
    check(`${width} 拉取使用服务器密钥，默认不变`,requests.at(-1)?.key==='Bearer server-key-secret'&&JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8')).models.custom==='shared-model');
    await page.getByRole('searchbox',{name:'搜索全部模型',exact:true}).fill('chat-model-299');
    await page.locator('[data-model="chat-model-299"]').getByRole('button',{name:'加入常用 chat-model-299',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.ml-model[data-model="chat-model-299"]').length===2);
    await page.locator('.ml-model[data-model="chat-model-299"]').first().getByRole('button',{name:'设默认',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('model-chip-text').textContent.includes('chat-model-299'));
    check(`${width} 服务器默认切换不覆盖本机`,await page.evaluate(()=>{const local=JSON.parse(localStorage.getItem('jarvis.llm.v1'));return local.models.custom==='local-model'&&local.keys.custom==='local-key-secret'&&!JSON.stringify(local).includes('server-key-secret');}));
    await page.getByRole('searchbox',{name:'搜索全部模型',exact:true}).fill('');
    await page.getByLabel('模型类别',{exact:true}).selectOption('image');
    await page.getByRole('button',{name:'用于画图',exact:true}).click();
    await page.waitForFunction(async()=>{const settings=JSON.parse(localStorage.getItem('jarvis.server.v1'));const response=await fetch(settings.url+'/api/server/config',{headers:{Authorization:'Bearer '+settings.token}});return (await response.json()).imageModel==='gpt-image-2';});
    const mediaConfig=JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8'));
    console.log('生成型号读回',JSON.stringify({width,diskImage:mediaConfig.imageModel,diskChat:mediaConfig.models?.custom}));
    check(`${width} 保留生成模型选择且不改变对话默认`,mediaConfig.imageModel==='gpt-image-2'&&mediaConfig.models.custom==='chat-model-299');
    await page.screenshot({path:path.join(output,`model-settings-${width}.png`)});
    await page.evaluate(()=>{document.body.classList.add('side-closed');document.body.classList.remove('side-open');});
    await page.click('#model-chip');
    await page.waitForSelector('.ml-picker-item');
    check(`${width} 对话只显示常用，保留同名模型的两个服务商`,await page.locator('.ml-picker-item').count()===3&&await page.locator('.ml-picker-provider').allTextContents().then(items=>items.includes('供应商 A')&&items.includes('供应商 B')));
    check(`${width} 模型面板不越界且无可见滚动条`,await page.locator('.ml-picker').evaluate(element=>{const rect=element.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1&&getComputedStyle(element.querySelector('.ml-picker-results')).scrollbarWidth==='none';}));
    await page.screenshot({path:path.join(output,`model-picker-${width}.png`)});
    await page.keyboard.press('Escape');
    check(`${width} Esc关闭且焦点返回模型入口`,await page.locator('.ml-picker').isHidden()&&await page.locator('#model-chip').evaluate(element=>element===document.activeElement));
    check(`${width} 无页面错误`,errors.length===0);
    await context.close();
    // 下一种尺寸从相同配置开始，便于比较。
    fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(serverConfig));
  }
} finally {
  await browser.close();
  gateway.kill();
  await new Promise(resolve=>upstream.close(resolve));
  fs.rmSync(data,{recursive:true,force:true});
}
console.log(`模型工作台 ${results.filter(Boolean).length}/${results.length} 通过`);
if(results.some(value=>!value))process.exitCode=1;
