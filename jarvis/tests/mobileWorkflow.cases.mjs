import assert from 'node:assert/strict';
import { skillCompatibility } from '../src/agent/skillCompatibility.js';
import { organizeFiles, fileCategory } from '../src/ui/fileOrganization.js';
import { createVoiceLifecycle, foregroundPolicy } from '../src/mobile/voiceLifecycle.js';
import { createTaskKeeper } from '../src/mobile/backgroundTasks.js';
import { recordVoiceEvent, readVoiceEvents } from '../src/mobile/voiceDiagnostics.js';
import { synthesize } from '../src/perception/tts.js';
import { selectVoiceEngine } from '../src/perception/voiceSelection.js';
const DEFAULT_VOICE = { engine:'auto' };
const resolveVoice = cfg => ({ engine:selectVoiceEngine(cfg) });
import { nativeFetcher } from '../src/mobile/nativeFetch.js';
import { Speaker } from '../src/perception/speaker.js';
const tick = () => new Promise(r => setImmediate(r));
async function globals(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for (const [k,value] of Object.entries(values)) Object.defineProperty(globalThis,k,{value,writable:true,configurable:true});
  try { return await fn(); } finally { for (const k of Object.keys(values)) { if (previous[k]) Object.defineProperty(globalThis,k,previous[k]); else delete globalThis[k]; } }
}
export const cases = [
  ['手机技能区分纯文字、Python 条件和电脑硬依赖', () => {
    const check = body => skillCompatibility({body},{mobile:true}).status;
    assert.equal(check('整理用户提供的会议记录'),'available'); assert.equal(check('使用 Python 分析表格'),'conditional');
    for (const body of ['必须安装 Docker','需要 pyautogui 控制鼠标','依赖 osascript','需要 Playwright 操作本机浏览器']) assert.equal(check(body),'blocked',body);
  }],
  ['明确平台元数据阻止手机使用，但可选与否定描述不误判', () => {
    assert.equal(skillCompatibility({meta:{platforms:'windows,macos'},body:'整理资料'},{mobile:true}).status,'blocked');
    assert.equal(skillCompatibility({meta:{mobile:false},body:'整理资料'},{mobile:true}).status,'blocked');
    assert.equal(skillCompatibility({body:'不需要 Docker\n可选：安装 Playwright\n整理成列表'},{mobile:true}).status,'available');
    assert.equal(skillCompatibility({body:'必须安装 Docker'},{mobile:false}).status,'available');
    assert.equal(skillCompatibility({unverified:true},{mobile:true}).status,'conditional');
  }],
  ['文件按更新时间置顶，分类与搜索共同生效，不改变输入顺序', () => {
    const files=[{path:'上传/截图.PNG',mtime:10},{path:'报告.docx',mtime:40},{path:'新截图.jpg',mtime:30},{path:'旧.txt'}];
    assert.deepEqual(organizeFiles(files).map(f=>f.path),['报告.docx','新截图.jpg','上传/截图.PNG','旧.txt']);
    assert.deepEqual(organizeFiles(files,{category:'image',query:'截图'}).map(f=>f.path),['新截图.jpg','上传/截图.PNG']);
    assert.equal(files[0].mtime,10); assert.equal(fileCategory('x/脚本.PY'),'code'); assert.equal(fileCategory('a.MP4'),'media');
  }],
  ['系统识别窗口不取消输入，但其他应用与系统窗口都静音', () => {
    assert.deepEqual(foregroundPolicy({hidden:true,nativeActive:false,systemDialog:true}),{audio:false,stopInput:false});
    assert.deepEqual(foregroundPolicy({hidden:true,nativeActive:false}),{audio:false,stopInput:true});
    assert.deepEqual(foregroundPolicy({hidden:false,nativeActive:false}),{audio:false,stopInput:true});
    assert.deepEqual(foregroundPolicy({}),{audio:true,stopInput:false});
  }],
  ['从系统识别窗口返回时，先到的可见性事件不误取消通话', async () => {
    let state={hidden:true,nativeActive:false,systemDialog:false}, left=0; const audio=[], timers=new Map();let id=0;
    await globals({setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)},async()=>{
      const lifecycle=createVoiceLifecycle({getState:()=>state,onAudio:a=>audio.push(a),onLeave:()=>left++});
      lifecycle.update(); state={hidden:false,nativeActive:true}; lifecycle.update();
      for(const fn of timers.values())fn(); assert.equal(left,0);assert.deepEqual(audio,[false,true]);
      state={hidden:true,nativeActive:false};lifecycle.update();for(const fn of timers.values())fn();assert.equal(left,1);lifecycle.dispose();
    });
  }],
  ['多个后台任务的引用计数和重复释放不会提前停保活服务', async () => {
    const calls=[];const keeper=createTaskKeeper({set:async p=>calls.push(p.active)});
    const a=keeper.begin(),b=keeper.begin();await tick();assert.deepEqual(calls,[true]);a();a();await tick();assert.equal(keeper.count,1);assert.deepEqual(calls,[true]);b();await tick();assert.deepEqual(calls,[true,false]);
  }],
  ['保活服务失败会报告，但不让任务计数卡死', async () => {
    const errors=[];const keeper=createTaskKeeper({set:async()=>{throw new Error('系统限制');}},e=>errors.push(e.message));
    const release=keeper.begin();await tick();release();await tick();assert.equal(keeper.count,0);assert.deepEqual(errors,['系统限制','系统限制']);
  }],
  ['切到其他应用立即取消朗读，返回后不补播后台队列', async () => {
    const spoken=[], synth={getVoices:()=>[],addEventListener(){},speak:u=>spoken.push(u.text),cancel(){}};
    await globals({speechSynthesis:synth,SpeechSynthesisUtterance:class{constructor(text){this.text=text;}}},async()=>{
      const speaker=new Speaker();speaker.speak('前台');assert.deepEqual(spoken,['前台']);
      speaker.setForeground(false);speaker.speak('后台不播放');assert.equal(speaker.speaking,false);assert.equal(speaker.enabled,true);
      speaker.setForeground(true);assert.deepEqual(spoken,['前台']);speaker.speak('新的前台回复');assert.deepEqual(spoken,['前台','新的前台回复']);speaker.cancel();await tick();
    });
  }],
  ['语音诊断只保留最近十二条并隐藏密钥', () => {
    const m=new Map(),store={getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)};
    for(let i=0;i<15;i++)recordVoiceEvent('错误',`Bearer token${i} sk-secret-value`,store);
    const entries=readVoiceEvents(store);assert.equal(entries.length,12);assert.ok(entries.every(e=>!e.detail.includes('sk-secret')&&!e.detail.includes('token')));
  }],
  ['去掉的声音引擎（Azure、服务商声音、自定义接口）明确报错，不把系统声音当作成功', async () => {
    for(const engine of ['azure','provider','custom','openai','elevenlabs'])await assert.rejects(synthesize({engine},{'azure-speech':'key'},'你好'),/不是云端语音引擎/);
  }],
  ['安卓原生网络返回的音频保持原始字节，不经 UTF-8 转换', async () => {
    const bytes=Uint8Array.from([255,251,0,128,199]);let requested;
    const native=nativeFetcher({request:async r=>{requested=r;return{status:200,data:btoa(String.fromCharCode(...bytes)),headers:{'content-type':'audio/mpeg'}}}});
    const ab=await synthesize({engine:'edge'},{},'你好',{fetchImpl:native,gateway:{origin:'https://gateway.invalid'}});
    assert.equal(requested.responseType,'arraybuffer');assert.deepEqual([...new Uint8Array(ab)],[...bytes]);
  }],
  ['自动音色：只在百炼、免费在线声音、系统自带三种里选；别家密钥不再自动用', async () => {
    await globals({__jarvisEdgeSpeech:{}},()=>{
      assert.equal(resolveVoice({keys:{openai:'key'},voice:DEFAULT_VOICE}).engine,'edge');
      assert.equal(resolveVoice({keys:{'azure-speech':'key'},voice:{...DEFAULT_VOICE,azureRegion:'eastasia'}}).engine,'edge');
      assert.equal(resolveVoice({provider:'relay-multi',keys:{'relay-multi':'key'},baseURLs:{'relay-multi':'https://relay.invalid/v1'},voice:DEFAULT_VOICE}).engine,'edge');
    });
  }]
];
