import { describe,it,expect } from 'vitest';
import { composerState } from '../src/ui/composerState.js';
import { BargeGate } from '../src/perception/bargeGate.js';
describe('输入栏状态',()=>{
 it('空白显示两个语音入口，输入文字或只有附件也能发送',()=>{
  expect(composerState()).toMatchObject({voice:true,send:false,stop:false});
  expect(composerState({text:'补充要求'})).toMatchObject({voice:false,send:true});
  expect(composerState({attachments:1})).toMatchObject({voice:false,send:true});
 });
 it('生成中的发送和停止同时可用，清空不隐藏停止',()=>{
  expect(composerState({text:'改成三页',generating:true})).toMatchObject({send:true,stop:true,voice:false});
  expect(composerState({generating:true})).toMatchObject({send:false,stop:true,voice:false});
 });
});
describe('朗读期间近端声音门控',()=>{
 it('持续足够时间才允许抢话，短碰撞和静音不触发',()=>{
  let t=0;const gate=new BargeGate({now:()=>t});
  expect(gate.feed(.1)).toBe(false);t=50;expect(gate.feed(.1)).toBe(false);
  t=70;expect(gate.feed(.001)).toBe(false);expect(gate.recent).toBe(false);
  t=100;gate.feed(.1);t=300;expect(gate.feed(.1)).toBe(true);expect(gate.recent).toBe(true);
  t=1200;expect(gate.recent).toBe(false);
 });
 it('每次朗读重新确认，不复用旧的声音证据',()=>{
  let t=0;const gate=new BargeGate({now:()=>t});gate.feed(.1);t=200;gate.feed(.1);
  gate.reset();expect(gate.recent).toBe(false);expect(gate.feed(.1)).toBe(false);
 });
});
