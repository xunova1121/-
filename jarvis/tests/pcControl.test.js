import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {IDBFactory} from 'fake-indexeddb';
import {needsComputer,computerTaskKind} from '../src/llm/router.js';
import {createToolLoader} from '../src/agent/toolLoader.js';
import {createOps} from '../desktop/ops.mjs';
import {createControl} from '../desktop/control.mjs';
import {createDesktopTools} from '../src/agent/desktopTools.js';
import {runAgent,COMPUTER_NOTE,trimComputerScreenshots} from '../src/agent/agent.js';

vi.mock('../src/agent/images.js',async original=>({...await original(),prepareImage:async()=>({mime:'image/png',data:'aW1hZ2U=',width:100,height:100})}));
let dir;
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();dir=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-pc-'));});
afterEach(()=>{vi.useRealTimers();delete globalThis.indexedDB;fs.rmSync(dir,{recursive:true,force:true});});

it('用户原话和多种PC任务在本机执行，附件与普通搜索不被劫持',()=>{
  for(const q of ['帮我打开天合云商2026年9月重点工作任务考核表-冷链 这个文档','打开天合云商2026年9月重点工作任务考核表-冷链','启动Excel','关闭微信','在记事本输入你好','把下载文件夹里的照片分类','双击右边那个图标','把工作区的文件保存到桌面'])expect(needsComputer(q),q).toBe(true);
  for(const q of ['打开工作区里的年度报告.docx','打开你刚生成的文档','分析这张截图里的错误','今天有什么新闻','如何打开Word文档'])expect(needsComputer(q),q).toBe(false);
  expect(computerTaskKind('点击右上角关闭按钮')).toBe('gui');expect(computerTaskKind('打开年度报告.docx')).toBe('files');
  const history=[{role:'assistant',content:'完成了点击',tools:['computer_click']}];
  expect(computerTaskKind('继续',{history})).toBe('gui');
  expect(needsComputer('继续搜索新闻',{history})).toBe(false);
  expect(needsComputer('继续',{history:[...history,{role:'assistant',content:'新闻回答'}]})).toBe(false);
});
it('多工具模式中本机搜索和能力查询常驻，不用先猜工具名',()=>{
  const tools=[...Array.from({length:35},(_,i)=>({name:`t${i}`,description:'x'})),{name:'computer_search',description:'本机文件'},{name:'computer_capabilities',description:'本机能力'}];
  const loader=createToolLoader(tools);expect(loader.list().map(t=>t.name)).toEqual(expect.arrayContaining(['computer_search','computer_capabilities']));
});
it('系统重定向目录被真实搜索并打开，默认查三处且不读文档正文',async()=>{
  const redirected=path.join(dir,'OneDrive-Documents');fs.mkdirSync(redirected);
  const filename=path.join(redirected,'天合云商2026年9月重点工作任务考核表-冷链.xlsx');fs.writeFileSync(filename,'fixture');
  const opened=[],calls=[];const ops=createOps({paths:{home:dir,desktop:path.join(dir,'Desktop'),documents:redirected,downloads:path.join(dir,'Downloads')},shell:{openPath:async p=>{opened.push(p);return'';}}});
  const desktop={platform:'win32',invoke:async(op,args)=>{calls.push(op);return ops[op](args);}};
  const tools=createDesktopTools(desktop);let n=0;
  const adapter={async stream(o){n++;expect(o.system.join('\n')).toContain(COMPUTER_NOTE);if(n===1){expect(o.tools.some(t=>t.name==='computer_search')).toBe(true);return{text:'',toolCalls:[{id:'find',name:'computer_search',args:{keyword:'天合云商'}}],stop:'tool_use'};}
    if(n===2){expect(o.messages.at(-1).content).toContain(filename);return{text:'',toolCalls:[{id:'open',name:'computer_open',args:{target:filename}}],stop:'tool_use'};}
    o.onText('打开请求已提交。');return{text:'打开请求已提交。',toolCalls:[],stop:'end_turn'};}};
  await runAgent({adapter,model:'test',history:[],userText:'帮我打开天合云商2026年9月重点工作任务考核表-冷链 这个文档',tools,context:{dynamic:'test'},quiet:true,emit:()=>{},approve:async()=>true});
  expect(opened).toEqual([filename]);expect(calls.filter(c=>c==='search')).toHaveLength(3);expect(calls).not.toContain('readFile');
});
it('文件路径不存在不能当程序运行；受限搜索不冒充查遍电脑',async()=>{
  const ops=createOps();await expect(ops.open({target:path.join(dir,'missing.xlsx')})).rejects.toThrow('路径不存在');
  const limited=createOps({now:(()=>{let t=0;return()=>t+=3000;})()});
  expect(await limited.search({dir,keyword:'missing'})).toMatchObject({truncated:true,reason:'搜索时间预算'});
  await expect(ops.search({dir,keyword:''})).rejects.toThrow('不能为空');
});
it('服务器没有桌面工具时不注入PC能力，普通聊天也不加PC长说明',async()=>{
  for(const [q,tools] of [['打开年度报告.docx',[]],['你好',createDesktopTools({platform:'win32',invoke:async()=>({})})]]){
    const adapter={async stream(o){expect(o.system.join('\n')).not.toContain(COMPUTER_NOTE);o.onText('答');return{text:'答',toolCalls:[],stop:'end_turn'};}};
    await runAgent({adapter,model:'m',history:[],userText:q,tools,context:{dynamic:'test'},quiet:true,emit:()=>{}});
  }
});
it('GUI看屏可超过两次；每次先看到新截图，不能同批看屏后盲点',async()=>{
  let n=0,clicks=0;const events=[];
  const adapter={async stream(o){if(++n<=4)return{text:'',toolCalls:[{id:`look${n}`,name:'computer_look',args:{}},...(n===1?[{id:'bad',name:'computer_click',args:{}}]:[])],stop:'tool_use'};o.onText('完成检查');return{text:'完成检查',toolCalls:[],stop:'end_turn'};}};
  const tools=[{name:'computer_look',description:'look',input_schema:{type:'object',properties:{}},run:async()=>({text:'屏幕',images:[{mime:'image/png',data:'aW1hZ2U='}]})},{name:'computer_click',description:'click',input_schema:{type:'object',properties:{}},run:async()=>{clicks++;return'ok';}}];
  await runAgent({adapter,model:'m',history:[],userText:'看屏幕',tools,context:{dynamic:'test'},quiet:true,emit:e=>events.push(e)});
  expect(events.filter(e=>e.type==='tool_end'&&e.name==='computer_look'&&e.ok)).toHaveLength(4);expect(clicks).toBe(0);expect(events.find(e=>e.id==='bad'&&e.type==='tool_end').output).toContain('下一步');
});
it('只裁剪旧GUI截图，用户图片和文本结果保留',()=>{
  const ms=[{role:'user',images:[{data:'user'}]},...Array.from({length:5},()=>({role:'tool',name:'computer_look',content:'screen',images:[{data:'shot'}]}))];
  trimComputerScreenshots(ms);expect(ms.filter(m=>m.role==='tool'&&m.images)).toHaveLength(2);expect(ms[0].images[0].data).toBe('user');expect(ms[1].content).toContain('screen');
});
it('GUI开始失败后能重试，未看屏不能盲输，动作失败后旧截图失效',async()=>{
  let begin=0,acts=0;const tools=createDesktopTools({platform:'win32',invoke:async op=>{if(op==='controlBegin'){if(++begin===1)throw Error('begin failed');return{};}if(op==='controlLook')return{base64:'aW1hZ2U=',width:100,height:100,cursor:{x:0,y:0}};if(op==='controlAct'){acts++;throw Error('action failed');}}});
  const get=n=>tools.find(t=>t.name===n);
  await expect(get('computer_look').run({})).rejects.toThrow('begin failed');await get('computer_look').run({});expect(begin).toBe(2);
  await expect(get('computer_click').run({x:1,y:1})).rejects.toThrow('action failed');
  await expect(get('computer_type').run({text:'x'})).rejects.toThrow('先调用');expect(acts).toBe(1);
});

function controlFixture(inputRun=async()=>{}) {
  let text='original',visible=false;
  const control=createControl({platform:'win32',input:{run:inputRun,close(){}},screen:{getCursorScreenPoint:()=>({x:30,y:40}),getPrimaryDisplay:()=>({id:2,bounds:{x:0,y:0,width:100,height:100},size:{width:100,height:100},scaleFactor:1})},clipboard:{readText:()=>text,writeText:t=>{text=t;}},getWin:()=>({isVisible:()=>visible,isMinimized:()=>false,hide:()=>{visible=false;},show:()=>{visible=true;},focus(){}}),desktopCapturer:{getSources:async()=>[{display_id:'1',thumbnail:{toPNG:()=>Buffer.from('wrong'),getSize:()=>({width:100,height:100})}},{display_id:'2',thumbnail:{toPNG:()=>Buffer.from('correct'),getSize:()=>({width:100,height:100})}}]}});
  return{control,text:()=>text,setText:t=>{text=t;},show:()=>{visible=true;}};
}
it('多屏按主屏ID取截图，不把另一块屏幕用于坐标定位',async()=>{
  const f=controlFixture();expect(Buffer.from((await f.control.look()).base64,'base64').toString()).toBe('correct');
});
it('粘贴失败恢复剪贴板；用户同时复制的新内容不被覆盖',async()=>{
  vi.useFakeTimers();
  for(const manual of [false,true]){
    let f;f=controlFixture(async()=>{if(manual)f.setText('user-new');throw Error('input failed');});
    const p=expect(f.control.act({type:'type',text:'bot'})).rejects.toThrow('input failed');await vi.advanceTimersByTimeAsync(1000);await p;expect(f.text()).toBe(manual?'user-new':'original');
  }
});
it('隐藏窗口等待期间停止，不再发出键盘动作',async()=>{
  vi.useFakeTimers();let calls=0;const f=controlFixture(async()=>{calls++;});f.show();
  const p=expect(f.control.act({type:'key',keys:'enter'})).rejects.toThrow('紧急停止');f.control.stop();await vi.advanceTimersByTimeAsync(1000);await p;expect(calls).toBe(0);
});
