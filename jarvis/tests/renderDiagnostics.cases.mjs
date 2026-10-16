import assert from 'node:assert/strict';
import { recordRenderError,copyRenderDiagnostics,renderSnapshot } from '../src/mobile/renderDiagnostics.js';
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
  }]
];
