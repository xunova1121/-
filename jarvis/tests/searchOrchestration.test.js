import {it,expect,vi} from 'vitest';
import {factCheck} from '../src/agent/factCheck.js';
import {createRetrievalBudget} from '../src/agent/retrievalBudget.js';
import {lookupRequirement,withLookupDeadline} from '../src/agent/lookupDeadline.js';
import {checkpointEvent,checkpointView} from '../shared/taskCheckpoint.js';
import {interruptionMark} from '../src/core/suggest.js';
const hits=[1,2,3,4].map(n=>({title:'测试对象',url:`https://source${n}.example/a`,snippet:''}));
const page='测试对象当天收盘价为13.4元。';
const llm=async()=>JSON.stringify({answer:'13.4',evidence:[{source:1,quote:page},{source:2,quote:page}]});
const args=()=>({question:'收盘价',items:[{label:'测试对象'}],date:'2026-10-19',mode:'quick',search:async()=>hits,read:async()=>page,llm});
it('单项快查一轮两词、两页并行、一次模型提取，引用仍逐字验证',async()=>{
 let active=0,max=0;const read=vi.fn(async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return page;});
 const search=vi.fn(async()=>hits),model=vi.fn(llm),budget=createRetrievalBudget('今天收盘价');
 const result=await factCheck({...args(),read,search,llm:model,consume:k=>budget.consume(k)});
 expect(search).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledTimes(2);expect(model).toHaveBeenCalledTimes(1);expect(max).toBe(2);expect(result.items[0].status).toBe('confirmed');
 expect(budget.resources).toEqual({search:2,read:2,model:1});
});
it('证据逐页持久化，再继续相同请求不重搜重读；过期或不同问题不复用',async()=>{
 let cp={};const onEvidence=async evidence=>{cp=checkpointEvent(cp,{type:'retrieval_evidence',evidence});};
 await factCheck({...args(),onEvidence});expect(cp.evidence[0].sources).toHaveLength(2);
 const search=vi.fn(async()=>hits),read=vi.fn(async()=>page);
 await factCheck({...args(),search,read,evidence:cp.evidence});expect(search).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
 await factCheck({...args(),question:'涨跌幅',search,read,evidence:cp.evidence});expect(search).toHaveBeenCalledTimes(2);
 search.mockClear();await factCheck({...args(),search,read,evidence:cp.evidence.map(x=>({...x,savedAt:Date.now()-11*60_000}))});expect(search).toHaveBeenCalledTimes(2);
});
it('内部请求跨工具共享资源上限；预算耗尽不调用提取模型',async()=>{
 const b=createRetrievalBudget('查价格');for(let i=0;i<6;i++)b.consume('search');
 const search=vi.fn(async()=>hits),model=vi.fn(llm);
 const result=await factCheck({...args(),search,llm:model,consume:k=>b.consume(k)});
 expect(search).not.toHaveBeenCalled();expect(model).not.toHaveBeenCalled();expect(result.items[0].status).toBe('error');
});
it('明确冲突不标成双来源已核实，编造引用仍无效',async()=>{
 const r=await factCheck({...args(),llm:async()=>JSON.stringify({answer:'不一致',conflict:'价格不同',evidence:[{source:1,quote:page},{source:2,quote:page}]})});expect(r.items[0].status).toBe('single');expect(r.items[0].conflict).toBe('价格不同');
 const fake=await factCheck({...args(),llm:async()=>JSON.stringify({answer:'99',evidence:[{source:1,quote:'不存在的价格99元'}]})});expect(fake.items[0].status).toBe('unverified');
});
it('继续普通查询仍有总期限，继续真正长任务保持原类别',async()=>{
 const history=[{role:'user',content:'今天收盘价多少'},{role:'assistant',content:'部分结果'}];
 expect(lookupRequirement('继续：从刚才中断的地方接着做',history)).toBe('今天收盘价多少');
 expect(lookupRequirement('继续：从刚才中断的地方接着做',[{role:'user',content:'写一份深度报告'}])).toContain('深度报告');
 vi.useFakeTimers();try{const p=withLookupDeadline({userText:'继续：从刚才中断的地方接着做',history},()=>new Promise(()=>{}),{totalMs:50});const check=expect(p).rejects.toMatchObject({code:'LOOKUP_TIMEOUT'});await vi.advanceTimersByTimeAsync(51);await check;}finally{vi.useRealTimers();}
});
it('证据有界、状态不误称网络断开',()=>{
 let c={};for(let i=0;i<8;i++)c=checkpointEvent(c,{type:'retrieval_evidence',evidence:{key:String(i),sources:Array.from({length:8},()=>({url:'https://a.example',text:'字'.repeat(10000)}))}});
 expect(c.evidence).toHaveLength(3);expect(c.evidence[0].sources).toHaveLength(4);expect(c.evidence[0].sources[0].text).toHaveLength(6000);
 expect(interruptionMark('本轮对话已等待 60 秒')).toContain('等待超时');expect(interruptionMark('模型接口返回 400')).toContain('模型接口');expect(interruptionMark('普通执行错误')).not.toContain('网络');
});

it('查看检查点只给证据索引，不把网页全文反复送给模型',()=>{
 const cp=checkpointEvent({text:'保留要求'},{type:'retrieval_evidence',evidence:{key:'q',sources:[{url:'https://example.test',title:'来源',text:'网页原文'}]}});
 const view=checkpointView(cp);expect(view.text).toBe('保留要求');expect(view.evidence[0].sources[0]).toEqual({url:'https://example.test',title:'来源'});expect(cp.evidence[0].sources[0].text).toBe('网页原文');
});
