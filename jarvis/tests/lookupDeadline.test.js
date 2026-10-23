import { describe, it, expect, vi } from 'vitest';
import { withLookupDeadline, isQuickLookup, moreTimeRequest, MORE_TIME_ASK, MORE_TIME_MS } from '../src/agent/lookupDeadline.js';
import { createLookupWindow, modelWindow, WRITING_GRACE_MS } from '../src/agent/lookupWindow.js';
import { runAgent } from '../src/agent/agent.js';

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
  it('重现“加图片炫酷一点”两次等待超时：话像闲聊，但模型调用了画图，就解除60秒时限',async()=>{
    vi.useFakeTimers();
    try{
      expect(isQuickLookup('加图片炫酷一点')).toBe(true);
      const p=withLookupDeadline({userText:'加图片炫酷一点',emit:()=>{}},async o=>{await delay(10_000);o.emit({type:'tool_start',name:'generate_image'});await delay(150_000);return {text:'图片已生成'};});
      await vi.advanceTimersByTimeAsync(160_000);expect(await p).toEqual({text:'图片已生成'});
      // 查资料类工具照旧受时限
      const q=withLookupDeadline({userText:question,emit:()=>{}},async o=>{o.emit({type:'tool_start',name:'web_search'});await delay(100_000);return {text:'迟到'};});
      const assertion=expect(q).rejects.toMatchObject({code:'LOOKUP_TIMEOUT'});
      await vi.advanceTimersByTimeAsync(60_000);await assertion;
    }finally{vi.useRealTimers();}
  });
});

describe('到点时把话写完（娱乐新闻半句话被截断）',()=>{
  const write=(o,from,to)=>(async()=>{for(let t=from;t<to;t+=2_000){await delay(2_000);o.emit({type:'text',delta:'字'});}})();
  it('60秒时还在连续出字：宽限到写完',async()=>{
    vi.useFakeTimers();
    try{
      const p=withLookupDeadline({userText:question,emit:()=>{}},async o=>{await delay(50_000);await write(o,50_000,75_000);return {text:'写完了'};});
      await vi.advanceTimersByTimeAsync(80_000);expect(await p).toEqual({text:'写完了'});
    }finally{vi.useRealTimers();}
  });
  it('宽限有上限：一直写个不停，最多再等30秒左右',async()=>{
    vi.useFakeTimers();
    try{
      const p=withLookupDeadline({userText:question,emit:()=>{}},async o=>{await write(o,0,300_000);return {text:'太长'};});
      const assertion=expect(p).rejects.toMatchObject({code:'LOOKUP_TIMEOUT'});
      await vi.advanceTimersByTimeAsync(60_000+WRITING_GRACE_MS+5_000);await assertion;
    }finally{vi.useRealTimers();}
  });
  it('到点时没在写（停了6秒以上）：照常结束',async()=>{
    vi.useFakeTimers();
    try{
      const p=withLookupDeadline({userText:question,emit:()=>{}},async o=>{await delay(40_000);o.emit({type:'text',delta:'一句'});await delay(100_000);return {text:'迟到'};});
      const assertion=expect(p).rejects.toMatchObject({code:'LOOKUP_TIMEOUT',partialText:'一句'});
      await vi.advanceTimersByTimeAsync(60_000);await assertion;
    }finally{vi.useRealTimers();}
  });
  it('收尾阶段的模型请求：在写就不掐，停笔后才结束',async()=>{
    vi.useFakeTimers();
    try{
      const control=createLookupWindow({totalMs:60_000});const controller=new AbortController();
      await vi.advanceTimersByTimeAsync(55_000);
      const frame=modelWindow(control,true,controller);
      const writing=setInterval(()=>control.wrote(),2_000);
      await vi.advanceTimersByTimeAsync(10_000);expect(controller.signal.aborted).toBe(false);
      clearInterval(writing);
      const check=expect(frame.race(new Promise(()=>{}))).rejects.toMatchObject({code:'LOOKUP_SUMMARY_TIMEOUT'});
      await vi.advanceTimersByTimeAsync(8_000);await check;frame.dispose();
    }finally{vi.useRealTimers();}
  });
});

describe('先给已有的，再问要不要再查',()=>{
  const history=[{role:'user',content:'今天娱乐新闻'},{role:'assistant',content:`……（普通问题我先回答到这里。${MORE_TIME_ASK}。）`}];
  it('认得“再查”；只回“要/好的”时，上一条得带了再查提示',()=>{
    expect(moreTimeRequest('再查',history)).toBe('今天娱乐新闻');
    expect(moreTimeRequest('再查一会儿',history)).toBe('今天娱乐新闻');
    expect(moreTimeRequest('好的',history)).toBe('今天娱乐新闻');
    expect(moreTimeRequest('好的',[{role:'user',content:'讲个故事'},{role:'assistant',content:'从前……'}])).toBeNull();
    expect(moreTimeRequest('今天股市',history)).toBeNull();
  });
  it('“再查”按原问题重查：不套一分钟时限，联网放到3分钟',async()=>{
    let got;await withLookupDeadline({userText:'再查',history},async o=>{got=o;return {text:'ok'};});
    expect(got.lookupDeadline).toBeUndefined();expect(got.timeBudgetMs).toBe(MORE_TIME_MS);
    expect(got.requirementText).toMatch(/^今天娱乐新闻/);expect(got.userText).toMatch(/今天娱乐新闻/);
  });
  it('查到次数上限时：结尾问要不要再查，不再叠两条“已停止”',async()=>{
    const WEB={name:'web_search',description:'测试用',input_schema:{type:'object',properties:{q:{type:'string'}}},run:async({q})=>`结果 ${q}`};
    let n=0;
    const adapter={async stream({tools}){n++;if(!tools.some(t=>t.name==='web_search'))return {text:'已查到的一部分。',toolCalls:[],stop:'end_turn'};return {text:'',toolCalls:[{id:String(n),name:'web_search',args:{q:`第${n}次`}}],stop:'tool_use'};}};
    const r=await runAgent({adapter,model:'x',history:[],userText:'今天娱乐新闻',context:{dynamic:''},tools:[WEB],emit:()=>{},maxSteps:40});
    expect(r.text).toContain(MORE_TIME_ASK);expect(r.text).not.toMatch(/本轮检索已停止|本轮已停止继续检索/);
  });
});

describe('模型自己判断要不要更多时间',()=>{
  it('普通问题时给模型 need_more_time；调用后解除一分钟时限',async()=>{
    vi.useFakeTimers();
    try{
      let n=0;let offered=false;
      const adapter={async stream({tools}){n++;
        if(n===1){offered=tools.some(t=>t.name==='need_more_time');return {text:'',toolCalls:[{id:'m',name:'need_more_time',args:{reason:'要对比很多来源'}}],stop:'tool_use'};}
        await delay(100_000);return {text:'做完了',toolCalls:[],stop:'end_turn'};}};
      const p=runAgent({adapter,model:'x',history:[],userText:question,context:{dynamic:''},tools:[],emit:()=>{}});
      await vi.advanceTimersByTimeAsync(110_000);
      const r=await p;expect(offered).toBe(true);expect(r.text).toContain('做完了');
    }finally{vi.useRealTimers();}
  });
  it('不是普通问题时不给这个工具',async()=>{
    let names=[];
    const adapter={async stream({tools}){names=tools.map(t=>t.name);return {text:'好',toolCalls:[],stop:'end_turn'};}};
    await runAgent({adapter,model:'x',history:[],userText:'写一份报告',context:{dynamic:''},tools:[],emit:()=>{}});
    expect(names).not.toContain('need_more_time');
  });
});

describe('评测 baseline-07/13 暴露的问题', () => {
  it('普通问题一个字没答出来：先自动多查，还没有就给一句完整的话，不留白', async () => {
    const WEB={name:'web_search',description:'测试用',input_schema:{type:'object',properties:{q:{type:'string'}}},run:async({q})=>`结果 ${q}`};
    let n=0;
    const adapter={async stream({tools}){n++;if(!tools.some(t=>t.name==='web_search'))return {text:'',toolCalls:[],stop:'end_turn'};return {text:'',toolCalls:[{id:String(n),name:'web_search',args:{q:`第${n}次`}}],stop:'tool_use'};}};
    const r=await runAgent({adapter,model:'x',history:[],userText:'最近一场中国男足比赛比分',context:{dynamic:''},tools:[WEB],emit:()=>{},maxSteps:40});
    // 先自动多查一会儿；还是没有就如实说没查到，不留白
    expect(r.text).toMatch(/没查到能核实的确切结果/);
  });
  it('普通问题里算数没用计算工具：收尾时提醒核对，而不是直接挂“数值计算尚未核对”', async () => {
    const seen=[];let n=0;
    const VERIFY={name:'verify_numbers',description:'算数',input_schema:{type:'object',properties:{expr:{type:'string'}}},run:async()=>'765'};
    const adapter={async stream({messages}){seen.push(String(messages.at(-1).content));n++;
      if(n===1)return {text:'净盈利 765 元。',toolCalls:[],stop:'end_turn'};
      if(n===2)return {text:'',toolCalls:[{id:'v',name:'verify_numbers',args:{expr:'1000*14.2-1000*13.4-35'}}],stop:'tool_use'};
      return {text:'',toolCalls:[],stop:'end_turn'};}};
    const r=await runAgent({adapter,model:'x',history:[],userText:'股票买入1000股，每股13.4元；卖出每股14.2元，手续费合计35元。净盈利多少？列算式。',context:{dynamic:''},tools:[VERIFY],emit:()=>{}});
    expect(seen.some(c=>/verify_numbers/.test(c))).toBe(true);
    expect(r.text).not.toMatch(/数值计算尚未通过计算工具核对/);
  });
});

describe('评测 baseline-07：一分钟内一个字都没答出来', () => {
  it('不交白卷：自动按原问题多查一会儿（不套一分钟、联网放到3分钟），不用用户回“再查”', async () => {
    const calls=[];
    const run=async(o)=>{calls.push(o);return calls.length===1?{text:'',needsMoreTime:true}:{text:'查到了：0比1'};};
    const events=[];
    const r=await withLookupDeadline({userText:question,emit:e=>events.push(e)},run);
    expect(r.text).toBe('查到了：0比1');
    expect(calls[1].lookupDeadline).toBeUndefined();
    expect(calls[1].timeBudgetMs).toBe(MORE_TIME_MS);
    expect(calls[1].requirementText).toMatch(/自动再查一会儿/);
    expect(events.some(e=>e.type==='tool_progress'&&/再多查一会儿/.test(e.text))).toBe(true);
  });
});
