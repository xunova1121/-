import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { runAgent } from '../src/agent/agent.js';
import { createTodayNewsTool } from '../src/agent/todayNews.js';
import { NEWS_SOURCES } from '../src/agent/newsSources.js';
import { createLookupModel } from '../src/agent/lookupModels.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { scheduledPrompt } from '../src/agent/scheduledRun.js';
import { createTaskTiming } from '../shared/taskTiming.js';
import { mergeConfig } from '../server/serverMode.mjs';
const context = {dynamic:''}; const now=Date.parse('2026-10-30T14:00:00Z');
const result = (text='',toolCalls=[]) => ({text,toolCalls,stop:toolCalls.length?'tool_use':'end_turn'});
const schema={type:'object',properties:{query:{type:'string'},url:{type:'string'}}};
it('实际对话和定时入口都先并发查新闻，主模型不用先决定搜索，原文核实工具仍可用', async()=>{
  for (const userText of ['今日新闻',scheduledPrompt({title:'每日重点新闻',prompt:'今日新闻，打开原文核实'},'2026/10/30 09:00')]) {
    const seen=[],get=vi.fn(async url=>new Response(fs.readFileSync(new URL('./fixtures/news/'+NEWS_SOURCES.find(s=>s.url===url).id+'.html',import.meta.url),'utf8')));
    const tool=createTodayNewsTool({fetchImpl:get,now:()=>now,newsSources:NEWS_SOURCES});
    const search=vi.fn(); const fetchPage=vi.fn(async()=> '已读取原文，正文信息');
    const adapter={stream:vi.fn(async o=>{seen.push(o);return result('今天的新闻已取得，先按实际来源整理。');})};
    const answer=await runAgent({adapter,model:'fixture',context,history:[],userText,now:()=>now,quiet:true,emit(){},tools:[tool,{name:'web_search',input_schema:schema,run:search},{name:'fetch_url',input_schema:schema,run:fetchPage}]});
    expect(get).toHaveBeenCalledTimes(3);expect(search).not.toHaveBeenCalled();expect(adapter.stream).toHaveBeenCalledTimes(userText.includes('原文核实') ? 2 : 1);
    if(userText.includes('原文核实')) expect(answer.review.outcome).toBe('partial');
    expect(seen[0].messages[0].content).toContain('系统已先查get_today_news');expect(seen[0].tools.some(t=>t.name==='fetch_url')).toBe(true);expect(answer.text).toContain('新闻');
  }
});
it('短状态抱怨不传联网工具、不允许原生搜索；明确重查仍提供工具',async()=>{
  for(const userText of ['发个新闻那么慢','你在干嘛','谁让你这么做的']){
    const search=vi.fn();const adapter={stream:vi.fn(async o=>{expect(o.tools).toEqual([]);expect(o.allowWebSearch).toBe(false);return result('这轮没有重新检索，我先说明当前进度。');})};
    await runAgent({adapter,model:'fixture',context,history:[],userText,quiet:true,emit(){},tools:[{name:'web_search',input_schema:schema,run:search}]});expect(search).not.toHaveBeenCalled();
  }
});
it('模拟模型同一步的两个搜索实际同时执行，耗时取并集而非相加；调用明细可追踪',async()=>{
  let started=0,release;const barrier=new Promise(resolve=>{release=resolve;});let calls=0;const events=[];
  const tool={name:'web_search',input_schema:schema,run:async({query})=>{started++;if(started===2)release();await barrier;return '- '+query+'\nhttps://example.com/'+query+'\n检索摘要内容';}};
  const adapter={stream:async()=>++calls===1?result('',[{id:'one',name:'web_search',args:{query:'甲'}},{id:'two',name:'web_search',args:{query:'乙'}}]):result('两方面的结果均已取得，来源见上文。')};
  await runAgent({adapter,model:'fixture',context,history:[],userText:'查两家公司的公开资料',quiet:true,emit:e=>events.push(e),tools:[tool]});
  expect(started).toBe(2);const firstEnd=events.findIndex(e=>e.type==='tool_end');expect(events.slice(0,firstEnd).filter(e=>e.type==='tool_start')).toHaveLength(2);
  const timing=createTaskTiming(0,()=>100);timing.start();events.forEach(e=>timing.event(e));expect(timing.finish().tools.web_search.calls).toBe(2);
});
it('推理档用于规划/读原文后的取舍，搜索后中间步骤主模型；不增加模型轮数',async()=>{
  const models=[],purposes=[];
  const reason={stream:async o=>{models.push(o.model);return models.length===1?result('',[{id:'s',name:'web_search',args:{query:'服务指南'}}]):result('申请方式已从正文取得，见 https://example.com/guide');}};
  const main={stream:async o=>{models.push(o.model);return result('',[{id:'r',name:'fetch_url',args:{url:'https://example.com/guide'}}]);}};
  const tools=[{name:'web_search',input_schema:schema,run:async()=>'- 服务指南\nhttps://example.com/guide\n报名入口信息'},{name:'fetch_url',input_schema:schema,run:async()=> '【网页读取回执】{"url":"https://example.com/guide"}\n服务指南\n'+ '这是实际读取的服务指南正文。'.repeat(10)}];
  await runAgent({adapter:main,model:'main',lookupModel:{adapter:reason,model:'reason'},context,history:[],userText:'查询服务指南',quiet:true,emit:e=>{if(e.phase==='model_start')purposes.push(e.purpose);},tools});
  expect(models).toEqual(['reason','main','reason']);expect(purposes[0]).toBe('lookup_plan');expect(purposes[2]).toBe('lookup_judgment');
});
it('推理未配/固定模型/配置无效时返回主模型，已配可用才接入',()=>{
  const cfg={provider:'custom',models:{custom:'main'},keys:{custom:'dummy'},baseURLs:{custom:'https://example.com'}};const make=vi.fn(()=>({adapter:{},model:'reason'}));
  expect(createLookupModel(cfg,make)).toBeNull();expect(make).not.toHaveBeenCalled();
  const set={...cfg,abilities:{reason:{main:{provider:'custom',model:'reason'}}}};
  expect(createLookupModel(set,make).model).toBe('reason');expect(createLookupModel({...set,pinModel:true},make)).toBeNull();expect(createLookupModel(set,()=>({problem:'配置不完整'}))).toBeNull();
});
it('已取得具体内容但模型空答时仍交付来源和摘要；不把摘要称原文核实',async()=>{
  let n=0;const adapter={stream:async()=>++n===1?result('',[{id:'s',name:'web_search',args:{query:'服务内容'}}]):result()};
  const answer=await runAgent({adapter,model:'fixture',context,history:[],userText:'查询服务内容',quiet:true,emit(){},tools:[{name:'web_search',input_schema:schema,run:async()=>'- 公共服务事项\nhttps://example.com/guide\n可以线上提交申请，具体条件见页面。'}]});
  expect(answer.text).toContain('线上提交申请');expect(answer.text).toContain('待核实');expect(answer.text).toContain('https://example.com/guide');
});
it('继续新闻时新预算可用而非沿用已耗尽对象，并重新先查新闻',async()=>{
  const calls=[];const tool={name:'get_today_news',input_schema:{type:'object',properties:{limit:{type:'integer'}}},run:async(args,{retrieval})=>{calls.push(retrieval.resources.read);retrieval.consume('read');return JSON.stringify({kind:'today_news',date:'2026-10-30',items:[],sources:[]});}};
  const adapter={stream:async()=>result('本次没有取得当日条目。')};
  for(const userText of ['今日新闻','继续','再查'])await runAgent({adapter,model:'fixture',context,history:[{role:'user',content:'今日新闻'},{role:'assistant',content:'上一轮读取额度用完'}],userText,now:()=>now,quiet:true,emit(){},tools:[tool]});
  expect(calls).toEqual([0,0,0]);
});
it('公开域名设置只更新相应字段、空清单保持禁用，非法值拒绝',()=>{
  const old={publicDataHosts:['api.github.com'],keys:{custom:'keep'},models:{custom:'main'}};
  expect(mergeConfig(old,{publicDataHosts:[]}).publicDataHosts).toEqual([]);expect(mergeConfig(old,{publicDataHosts:['data.example.com']}).keys.custom).toBe('keep');expect(()=>mergeConfig(old,{publicDataHosts:['localhost']})).toThrow();
});
it('公开JSON空答也有真实数据摘要，截断数据不冒充完整结果',()=>{
  const delivery=createLookupDelivery('查询公开数据');delivery.record({name:'fetch_json',ok:true,output:JSON.stringify({kind:'public_json',url:'https://example.com/api',data:{count:18}})});expect(delivery.text()).toContain('18');expect(delivery.text()).not.toContain('待核实：尚未读取报道原文');
});
it('新联网工具耗时归入读取阶段，不算模型或普通工具时间',()=>{
  let tick=0;const timing=createTaskTiming(0,()=>tick);timing.start();timing.event({type:'tool_start',id:'n',name:'get_today_news'});tick=5;timing.event({type:'tool_start',id:'j',name:'fetch_json'});tick=15;timing.event({type:'tool_end',id:'n',name:'get_today_news',ok:true});tick=20;timing.event({type:'tool_end',id:'j',name:'fetch_json',ok:true});expect(timing.finish()).toMatchObject({readMs:20,otherToolMs:0,toolMs:20});
});
it('汇总页回执算实际检索，但不能冒充已打开原文；全源失败不算查到资料',async()=>{
  const {createExecutionReview}=await import('../src/agent/executionReview.js');
  const {reviewOutcome}=await import('../src/agent/reviewOutcome.js');
  const review=createExecutionReview('今日新闻，打开原文核实');
  review.record({name:'get_today_news',ok:true,output:JSON.stringify({kind:'today_news',items:[{url:'https://example.com/article'}]})});
  expect(review.report().retrievalReceipts).toBe(1);expect(review.report().sourceIssue).toContain('只取得汇总页');expect(reviewOutcome(review.report()).outcome).toBe('partial');
  review.record({name:'fetch_url',args:{url:'https://example.com/article'},ok:true,output:'实际原文正文'});expect(review.report().sourceIssue).toBe('');
  const failed=createExecutionReview('今日新闻');failed.record({name:'get_today_news',ok:true,output:JSON.stringify({kind:'today_news',items:[]})});expect(failed.report().retrievalReceipts).toBe(0);
});
it('明确逐条核实不能用一篇原文替代所选全部报道',async()=>{
  const {createExecutionReview}=await import('../src/agent/executionReview.js');const review=createExecutionReview('今日新闻，逐条打开原文核实');
  const urls=['https://example.com/a','https://example.com/b'];review.record({name:'get_today_news',ok:true,output:JSON.stringify({kind:'today_news',items:urls.map(url=>({url}))})});
  review.record({name:'fetch_url',args:{url:urls[0]},ok:true,output:'实际读取第一篇原文'});review.checkAnswer('新闻一 '+urls[0]+'\n新闻二 '+urls[1]);expect(review.report().sourceIssue).toContain('汇总页');
  review.record({name:'fetch_url',args:{url:urls[1]},ok:true,output:'实际读取第二篇原文'});review.checkAnswer('新闻一 '+urls[0]+'\n新闻二 '+urls[1]);expect(review.report().sourceIssue).toBe('');
});
it('普通查询有资料后仍边生成边显示，不为兜底整段缓冲',async()=>{
  let calls=0;const visible=[];const adapter={stream:async({onText})=>{if(!calls++)return result('',[{id:'s',name:'web_search',args:{query:'服务内容'}}]);onText('第一段回答');expect(visible.join('')).toContain('第一段回答');onText('第二段回答');return result();}};
  await runAgent({adapter,model:'fixture',context,history:[],userText:'查询服务内容',quiet:true,emit:e=>{if(e.type==='text')visible.push(e.delta);},tools:[{name:'web_search',input_schema:schema,run:async()=>'- 公共服务事项\nhttps://example.com/service\n可以线上办理'}]});expect(visible.join('')).toContain('第二段回答');
});
it('状态询问中途追加真实查询会恢复联网能力，不因初句抱怨永久裁掉工具',async()=>{
  let calls=0;const inbox=[];const search=vi.fn(async()=>'- 公共资料\nhttps://example.com/data\n资料摘要');
  const adapter={stream:async({tools})=>{calls++;if(calls===1){expect(tools).toEqual([]);inbox.push('帮我查询服务渠道');return result('我先说明进度。');}if(calls===2){expect(tools.some(t=>t.name==='web_search')).toBe(true);return result('',[{id:'s',name:'web_search',args:{query:'服务渠道'}}]);}return result('已取得公共资料。');}};
  await runAgent({adapter,model:'fixture',context,history:[],userText:'你在干嘛',inbox,quiet:true,emit(){},tools:[{name:'web_search',input_schema:schema,run:search}]});expect(search).toHaveBeenCalledTimes(1);
});
it('原生联网也从搜索兜底扣除，下轮请求只获得剩余次数',async()=>{
  const {createModelRequest}=await import('../src/agent/agentModelRequest.js');const {createRetrievalBudget}=await import('../src/agent/retrievalBudget.js');
  const retrieval=createRetrievalBudget('查询公共资料');const counts=[];const current={model:'fixture',adapter:{stream:async o=>{counts.push(o.maxWebSearches);o.onText('',{serverTool:'web_search'});return result('已取得结果');}}};
  for(let i=0;i<2;i++){const req=createModelRequest({current,retrieval,emit(){},onNativeSearch(){},onText(){},closing:false,lookupDeadline:false});try{await req.run({system:[],messages:[],tools:[]});}finally{req.dispose();}}
  expect(retrieval.resources.search).toBe(2);expect(counts).toEqual([12,11]);
});
it('中间主模型直接收尾时最多转交推理档一次；只展示最终一份，不让收尾继续调用工具',async()=>{
  let reasonCalls=0;const seen=[],visible=[];
  const reason={stream:async o=>{seen.push(o.model);if(!reasonCalls++)return result('',[{id:'s',name:'web_search',args:{query:'公共服务'}}]);expect(o.tools).toEqual([]);expect(o.allowWebSearch).toBe(false);o.onText('最终答复：具体服务见 https://example.com/guide，尚未读原文。');return result();}};
  const main={stream:async o=>{seen.push(o.model);o.onText('中间候选，不应提前展示');return result();}};
  await runAgent({adapter:main,model:'main',lookupModel:{adapter:reason,model:'reason'},context,history:[],userText:'查询公共服务',quiet:true,emit:e=>{if(e.type==='text')visible.push(e.delta);},tools:[{name:'web_search',input_schema:schema,run:async()=>'- 公共服务内容\nhttps://example.com/guide\n可在线提交申请'}]});
  expect(seen).toEqual(['reason','main','reason']);expect(visible.join('')).not.toContain('中间候选');expect(visible.join('')).toContain('最终答复');
});
it('自动续查的系统说明不把普通问题升级为逐项核验，预算类别仍取用户原话',async()=>{
  const {withLookupDeadline}=await import('../src/agent/lookupDeadline.js');let calls=0;let resumed;
  await withLookupDeadline({userText:'今天汇率多少',history:[],tools:[],emit(){}},async options=>{if(!calls++)return {needsMoreTime:true};resumed=options;return {text:'没有取得结果'};});
  expect(resumed.retrievalText).toBe('今天汇率多少');expect(resumed.requirementText).toContain('原文核实');
});
it('抱怨后的明确继续/再查仍继承真正的新闻问题，不把抱怨当查询词',async()=>{
  const {lookupRequirement,moreTimeRequest}=await import('../src/agent/lookupDeadline.js');const history=[{role:'user',content:'今日新闻'},{role:'assistant',content:'本轮部分完成'},{role:'user',content:'发个新闻那么慢'},{role:'assistant',content:'没有重新搜索。'}];
  expect(lookupRequirement('继续',history)).toBe('今日新闻');expect(moreTimeRequest('再查',history)).toBe('今日新闻');
});
it('纯写作不注入联网收尾规则，避免把文章再次写成核实说明',async()=>{
  const adapter={stream:async({system})=>{expect(system.join('\n')).not.toContain('查几个方面或几个对象时');return result('这是正文。');}};
  const answer=await runAgent({adapter,model:'fixture',context,history:[],userText:'写一篇工作心得',quiet:true,emit(){},tools:[]});expect(answer.text).toContain('正文');
});
it('检索与状态动态规则只留本轮，不回写调用方共用上下文',async()=>{
  const shared={dynamic:'调用方背景'};const adapter={stream:async()=>result('简短回答')};
  for(const userText of ['查询公开服务','你在干嘛','写一篇工作心得'])await runAgent({adapter,model:'fixture',context:shared,history:[],userText,quiet:true,emit(){},tools:[]});
  expect(shared.dynamic).toBe('调用方背景');
});
