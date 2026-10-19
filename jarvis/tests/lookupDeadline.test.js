import { describe, it, expect, vi } from 'vitest';
import { withLookupDeadline, isQuickLookup } from '../src/agent/lookupDeadline.js';

const question='现在播放的电视剧伟大的长征播放哪一集了，内容是什么';
const delay=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

describe('普通对话总时限',()=>{
  it('覆盖用户电视剧原话、新闻娱乐和闲聊；文档、编码、明确深查及副作用任务不截为60秒',()=>{
    for(const text of [question,'你好','谢谢','这些娱乐新闻是真的吗','比较这两部电影的票房','演员是谁']) expect(isQuickLookup(text),text).toBe(true);
    for(const text of ['写一份报告','做个PPT','开发网页','修改文件','深度调研影视产业','继续','发送邮件']) expect(isQuickLookup(text),text).toBe(false);
  });
  it('重现268秒等待：没有任何搜索事件或首字，60秒仍能停止，而非等待120秒再重试',async()=>{
    vi.useFakeTimers();
    try{
      let child;const events=[];
      const p=withLookupDeadline({userText:question,emit:e=>events.push(e)},async o=>{child=o;await delay(268_000);o.emit({type:'text',delta:'迟到的答案'});return {text:'迟到的答案'};});
      const assertion=expect(p).rejects.toMatchObject({code:'LOOKUP_TIMEOUT',partialText:''});
      await vi.advanceTimersByTimeAsync(60_000);await assertion;expect(child.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(208_000);expect(events).toEqual([]);
    }finally{vi.useRealTimers();}
  });
  it('搜索阶段、多个重试与最后整理共享60秒；先说一句话不会重置总计时',async()=>{
    vi.useFakeTimers();
    try{
      const p=withLookupDeadline({userText:question,emit:()=>{}},async o=>{
        await delay(20_000);o.emit({type:'text',delta:'我再核实一下。'});
        await delay(20_000);o.emit({type:'server_tool',name:'web_search'});
        await delay(228_000);return {text:'迟到的整理'};
      });
      const assertion=expect(p).rejects.toMatchObject({code:'LOOKUP_TIMEOUT',partialText:'我再核实一下。'});
      await vi.advanceTimersByTimeAsync(60_000);await assertion;
    }finally{vi.useRealTimers();}
  });
  it('用户停止立刻取消，不误报为超时；已经停止时不发请求',async()=>{
    const ctrl=new AbortController();const run=vi.fn(()=>new Promise(()=>{}));
    const p=withLookupDeadline({userText:'你好',signal:ctrl.signal},run);ctrl.abort();
    await expect(p).rejects.toMatchObject({name:'AbortError'});
    const never=vi.fn();await expect(withLookupDeadline({userText:'你好',signal:ctrl.signal},never)).rejects.toMatchObject({name:'AbortError'});expect(never).not.toHaveBeenCalled();
  });
  it('中途追加报告任务时解除普通对话总时限，原任务继续，截止前尚未读入的补充也保留',async()=>{
    vi.useFakeTimers();
    try{
      const p=withLookupDeadline({userText:question},async o=>{await delay(30_000);o.onTaskUpdate('整理成Word报告');await delay(60_000);return {text:'报告完成'};});
      await vi.advanceTimersByTimeAsync(90_000);expect(await p).toEqual({text:'报告完成'});
      const inbox=[];const late=withLookupDeadline({userText:question,inbox},async()=>{await delay(90_000);return '补充保留';});
      inbox.push('制作PPT');await vi.advanceTimersByTimeAsync(90_000);expect(await late).toBe('补充保留');
    }finally{vi.useRealTimers();}
  });
  it('正常结束清理计时器，后续不再超时；长任务仍传原配置',async()=>{
    const result=await withLookupDeadline({userText:'你好'},async()=>({text:'你好'}));expect(result.text).toBe('你好');
    const options={userText:'写一份报告'};await withLookupDeadline(options,async o=>expect(o).toBe(options));
  });
});
