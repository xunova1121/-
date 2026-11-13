import assert from 'node:assert/strict';
import { recordRenderError,copyRenderDiagnostics,renderSnapshot,describeScreen,startScreenTrail,SCREEN_STARTING } from '../src/mobile/renderDiagnostics.js';
export const cases=[
  ['渲染诊断只保留十次错误类型，不保存错误正文或密钥',()=>{
    const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
    for(let i=0;i<20;i++)recordRenderError({type:'error',error:{name:'TypeError',message:'sk-private-secret'},lineno:i},storage);
    const events=JSON.parse(data.get('jarvis.renderEvents'));assert.equal(events.length,10);assert.equal(events[0].line,10);assert.ok(!JSON.stringify(events).includes('secret'));
  }],
  ['复制诊断不携带旧异常中的聊天内容和服务密钥',async()=>{
    let copied='';const plugin={diagnostics:async()=>({app:'1.0.test',webview:'114',lastRenderer:'didCrash=true'}),copyDiagnostics:async({text})=>{copied=text;}};
    const storage={getItem:k=>k==='jarvis.lastCrash'?'secret chat sk-private-secret':null};
    await copyRenderDiagnostics({plugin,storage,snapshot:{messages:12,nodes:200},clipboard:{writeText:()=>{throw Error('不应依赖网页剪贴板');}}});
    const report=JSON.parse(copied);assert.equal(report.native.app,'1.0.test');assert.equal(report.view.messages,12);assert.equal(report.hasPreviousCrash,true);assert.ok(!copied.includes('secret'));
  }],
  ['无原生诊断插件时仍能复制界面规模',async()=>{
    let copied;await copyRenderDiagnostics({plugin:null,storage:{getItem:()=>null},snapshot:{messages:0},clipboard:{writeText:async text=>{copied=text;}}});assert.equal(JSON.parse(copied).view.messages,0);
  }],
  ['界面快照只统计消息大小，不记录正文',()=>{
    const doc={documentElement:{classList:{contains:()=>true}},body:{classList:{contains:()=>false}},querySelectorAll:()=>[{querySelector:()=>({textContent:'private chat'})}],getElementsByTagName:()=>({length:50}),hidden:false};
    const view=renderSnapshot({doc,perf:{memory:{usedJSHeapSize:1048576}}});assert.equal(view.characters,12);assert.equal(view.messages,1);assert.equal(view.jsHeapMB,1);assert.ok(!JSON.stringify(view).includes('private'));
  }],
  ['记下崩溃前在哪个界面：首页 / 对话 / 面板、打开多久、动画多少，不记聊天内容',()=>{
    const mk=({splash=false,msgs=0,side=false})=>({documentElement:{classList:{contains:()=>false}},body:{classList:{contains:c=>side&&c==='side-open'}},getElementById:id=>id==='app-splash'&&splash?{}:null,querySelector:()=>({dataset:{pane:'settings'}}),querySelectorAll:()=>Array.from({length:msgs},()=>({querySelector:()=>({textContent:'私密聊天'})})),getElementsByTagName:()=>({length:900}),getAnimations:()=>[1,2,3],hidden:false});
    assert.match(describeScreen({doc:mk({}),startedAt:0,now:192000}),/^首页 · 已打开 3 分 12 秒 · 消息 0 条 · 动画 3 个 · 元素 900 个 · 兼容显示关$/);
    assert.match(describeScreen({doc:mk({msgs:4}),startedAt:0,now:8000}),/^对话 · 已打开 8 秒 · 消息 4 条/);
    assert.match(describeScreen({doc:mk({side:true})}),/^面板（settings）/);
    assert.match(describeScreen({doc:mk({splash:true})}),/^启动页/);
    assert.ok(!describeScreen({doc:mk({msgs:4})}).includes('私密'));
  }],
  ['启动时取出上一次运行最后的界面，再从“刚打开”开始记这一次',()=>{
    const data=new Map([['jarvis.lastScreen','首页 · 已打开 40 秒']]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
    let tick;const doc={documentElement:{classList:{contains:()=>false}},body:{classList:{contains:()=>false}},getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],getElementsByTagName:()=>({length:10}),hidden:false,addEventListener(){}};
    const notes=[];const prev=startScreenTrail({storage,doc,now:()=>0,timer:f=>{tick=f;},note:x=>notes.push(x)});
    assert.equal(prev,'首页 · 已打开 40 秒');assert.equal(data.get('jarvis.lastScreen'),SCREEN_STARTING);
    tick();assert.match(data.get('jarvis.lastScreen'),/^首页 · 已打开 0 秒/);
    assert.equal(notes[0],SCREEN_STARTING);assert.match(notes[1],/^首页/); // 也报给原生层，界面打不开时原生记录里也有
  }],
];
