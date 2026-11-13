import assert from 'node:assert/strict';
import { transcriptWindow } from '../src/mobile/transcriptWindow.js';
import { applyDisplayMode } from '../src/mobile/renderHealth.js';
export const cases = [
  ['手机只渲染最近 24 条，兼容模式 12 条', () => {
    assert.deepEqual(transcriptWindow(400,{mobile:true}),{start:376,end:400,limit:24,older:376,newer:0});
    assert.equal(transcriptWindow(400,{mobile:true,safe:true}).start,388);
    assert.equal(transcriptWindow(400).start,0);
  }],
  ['翻页可遍历全部历史，不删除或改变消息', () => {
    const history=Array.from({length:67},(_,i)=>({content:String(i)})), snapshot=JSON.stringify(history), seen=[];
    let end=history.length;
    while(end>0){const r=transcriptWindow(history.length,{mobile:true,safe:true,end});assert.ok(r.end-r.start<=12);seen.unshift(...history.slice(r.start,r.end));end=r.start;}
    assert.deepEqual(seen,history);assert.equal(JSON.stringify(history),snapshot);
  }],
  ['空历史和越界翻页仍有界', () => {
    assert.deepEqual(transcriptWindow(0,{mobile:true}),{start:0,end:0,limit:24,older:0,newer:0});
    assert.equal(transcriptWindow(5,{mobile:true,end:999}).end,5);
    assert.equal(transcriptWindow(5,{mobile:true,end:-7}).start,0);
  }],
  ['兼容模式可即时开启与关闭，不触发页面刷新', () => {
    const flags=new Set(),values=new Map();
    const options={root:{classList:{toggle:(name,on)=>on?flags.add(name):flags.delete(name)}},storage:{setItem:(k,v)=>values.set(k,v)}};
    applyDisplayMode(true,options);assert.ok(flags.has('safe-render'));assert.equal(values.get('jarvis.renderSafe'),'true');
    applyDisplayMode(false,options);assert.equal(flags.size,0);assert.equal(values.get('jarvis.renderSafe'),'false');
  }],
  ['存储不可写也可启用本次兼容显示', () => {
    let applied;applyDisplayMode(true,{root:{classList:{toggle:(name,on)=>{applied=on;}}},storage:{setItem:()=>{throw Error('blocked');}}});assert.equal(applied,true);
  }]
];
