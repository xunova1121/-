import {describe,it,expect,vi} from 'vitest';
import {readableRecovery} from '../src/agent/lookup/recoveryData.js';
import {createLookupClock, modelWindow} from '../src/agent/lookup/clock.js';
import {finishAgentRun} from '../src/agent/agentCompletion.js';
import {createLookupDelivery} from '../src/agent/lookupDelivery.js';
// 用户 2026-11-01：问“现在玉昆比分多少”，界面直接甩出整段搜索回执、网页导航栏和ICP备案号
const raw=`玉昆2-0领先！克莱伯中路扫射破门
# 玉昆2-0领先！ 2026-11-01 19:51 来源: 直播吧 ... 比赛第14分钟，克莱伯推射破门，云南玉昆2-0领先大连英博。   （DeepSeek检索摘要，未读原文） 发布时间：2026-10-31T16:00:00+00:00
https://www.sohu.com/a/1095780804_362070

英博扳回一球！德尔加多兜射破门
# 英博扳回一球！ ... 比赛第21分，大连英博扳回一球1-2落后云南玉昆。   （DeepSeek检索摘要，未读原文）
https://news.zhibo8.com/zuqiu/2026-11-01/6ae728f8d0113native.htm

来源原文：https://news.zhibo8.com/zuqiu/2026-11-01/6ae728f8d0113native.htm
【网页读取回执】{"url":"x"}
首页
 NBA视频
 闽ICP备15018471号-4
【页面内链接（链接指向的内容尚未读取）】
1. 下载客户端 — https://www.zhibo8.com/shouji.htm`;
const recovery={state:'recovered',note:'原赛程服务暂时没有结果，已改用来源原文取得以下内容。'};
describe('兜底资料给人看',()=>{
  it('每条一行标题+摘要+链接，不贴网页导航、备案号和检索器标注',()=>{
    const text=readableRecovery({output:raw,recovery});
    expect(text).toContain('**玉昆2-0领先！克莱伯中路扫射破门**');expect(text).toContain('1-2落后云南玉昆');expect(text).toContain('[来源](https://news.zhibo8.com/zuqiu/2026-11-01/6ae728f8d0113native.htm)');
    for(const junk of ['NBA视频','ICP','页面内链接','检索摘要','发布时间','【网页读取回执】','下载客户端'])expect(text).not.toContain(junk);
    expect(text).toContain('已打开其中一篇原文');
  });
  it('交付兜底文字走可读摘要',()=>{
    const d=createLookupDelivery('现在玉昆比分多少');
    d.record({name:'get_sports_scores',ok:true,output:'',lookupRecovery:{...recovery,tool:'web_search',output:raw}});
    expect(d.text()).not.toContain('ICP');expect(d.text()).toContain('玉昆');
  });
  it('程序换来源取到资料后可多给模型写答案的时间，首字窗口同步放宽',()=>{
    let t=0;const c=createLookupClock({totalMs:40000,phased:true,now:()=>t});
    c.extend(30000);expect(c.remaining()).toBe(70000);expect(c.bonusMs).toBe(30000);expect(c.totalMs).toBe(70000);
    vi.useFakeTimers();
    try{
      const ctrl=new AbortController();const w=modelWindow(c,false,ctrl);
      vi.advanceTimersByTime(20000);expect(ctrl.signal.aborted).toBe(false);// 原先15秒没首字就掐断
      vi.advanceTimersByTime(26000);expect(ctrl.signal.aborted).toBe(true);w.dispose();
    }finally{vi.useRealTimers();}
  });
  it('模型已写了回答（哪怕说没查到）就不再在后面贴资料堆',async()=>{
    const events=[];const retrieval={active:true,reason:'',extensive:false};
    const review={report:()=>({request:'今天没有中超比赛吗',warnings:[]}),guidance:()=>''};
    const answer='**目前没有查到今天有中超比赛。**直播吧公开赛程页在北京时间 11 月 1 日没有返回中超对阵。我上一条把微博搜索摘要当作今天的赛果，那条不可靠，抱歉。';
    const r=await finishAgentRun({step:1,limit:8,retrievalStopped:false,retrieval,stuck:false,review,nativeSearchCalls:0,light:false,signal:null,quiet:true,toolCount:1,lastToolOk:true,failCount:0,userText:'今天没有中超比赛吗',finalText:answer,emit:e=>events.push(e),lookupFallback:'原搜索服务暂时没有结果……微博正文'});
    expect(r.text).not.toContain('微博正文');
  });
});
