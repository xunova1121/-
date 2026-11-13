import {describe,it,expect} from 'vitest';
import {runHedged} from '../src/agent/hedgedRequest.js';
import {createTaskTiming} from '../shared/taskTiming.js';
import {recentWorkLog} from '../src/agent/failedSteps.js';
// 用户 2026-11-03：底栏显示 deepseek-flash-1017 答的，未央却说“实际换成了 gpt-6-luna”；执行记录只写“换备用模型2次”
describe('换备用模型时说清楚是谁',()=>{
  it('同时请求备用模型时，备用模型拿到写着它自己名字的系统说明',async()=>{
    let seen=null;
    const primary={run:()=>new Promise(()=>{}),abort(){},dispose(){}};
    const makeBackup=()=>({run:async(input)=>{seen=input.system;return {text:'好',toolCalls:[]};},abort(){},dispose(){}});
    const {used}=await runHedged({primary,onPrimaryActivity(){},makeBackup,input:{system:'这一轮由 A 回答'},backupInput:{system:'这一轮实际由 B 回答'},hedgeMs:5,onText(){},onHedge(){},onSwitch(){}});
    expect(used).toBe('backup');expect(seen).toBe('这一轮实际由 B 回答');
  });
  it('耗时记录写下每次换模型的来去和原因，执行记录照实列出',()=>{
    let t=0;const timing=createTaskTiming(0,()=>t);timing.start();
    timing.event({type:'fallback',from:'deepseek-v4.1-flash',to:'gpt-6-luna',reason:'服务返回 500'});
    timing.event({type:'fallback',from:'gpt-6-luna',to:'deepseek-flash-1017',slow:true,reason:'20 秒没有反应'});
    const snap=timing.finish();
    expect(snap.fallbacks).toBe(2);expect(snap.fallbackSteps).toEqual([{from:'deepseek-v4.1-flash',to:'gpt-6-luna',reason:'服务返回 500'},{from:'gpt-6-luna',to:'deepseek-flash-1017',reason:'20 秒没有反应'}]);
    const log=recentWorkLog([{role:'assistant',content:'新闻……',timing:snap}]);
    expect(log).toContain('换模型经过：deepseek-v4.1-flash → gpt-6-luna（服务返回 500）；gpt-6-luna → deepseek-flash-1017（20 秒没有反应）');
  });
  it('没换过模型时不多写',()=>{
    let t=0;const timing=createTaskTiming(0,()=>t);timing.start();
    expect(timing.finish().fallbackSteps).toBeUndefined();
  });
});
