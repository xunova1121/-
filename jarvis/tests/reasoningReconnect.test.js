import { it, expect, vi } from 'vitest';
import { createOpenAIAdapter, createAccumulator, toOpenAIMessages } from '../src/llm/openai.js';
import { followTask } from '../src/core/serverClient.js';

it('推理字段分片收集、工具续调原样回传，隐藏内容不作为正文', async () => {
 const requests=[], visible=[];
 const chunks = [
  {choices:[{delta:{reasoning_content:'先核对'}}]},
  {choices:[{delta:{reasoning_content:'资料',tool_calls:[{index:0,id:'c1',function:{name:'read_file',arguments:'{}'}}]},finish_reason:'tool_calls'}]}
 ];
 const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  requests.push(JSON.parse(init.body));
  if(requests.length===2 && requests[1].messages[1].reasoning_content!=='先核对资料') return new Response('reasoning_content must be passed back',{status:400});
  const data=requests.length===1?chunks:[{choices:[{delta:{content:'已核对'},finish_reason:'stop'}]}];
  return new Response(data.map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''));
 });
 try {
  const adapter=createOpenAIAdapter({baseURL:'https://example.test',retryDelays:[]});
  const first=await adapter.stream({model:'thinking',system:[],messages:[],tools:[],onText:d=>visible.push(d)});
  const next=await adapter.stream({model:'thinking',system:[],tools:[],messages:[
   {role:'assistant',content:first.text,toolCalls:first.toolCalls,raw:first.raw},
   {role:'tool',toolCallId:'c1',content:'结果'}
  ],onText:d=>visible.push(d)});
  expect(next.text).toBe('已核对'); expect(visible).toEqual(['已核对']);
  expect(requests[1].messages[1]).toMatchObject({reasoning_content:'先核对资料',tool_calls:[{id:'c1'}]});
 } finally { fetchMock.mockRestore(); }
});

it('其他协议raw不误当推理；无字段不捏造，非流式最终message兼容',()=>{
 expect(toOpenAIMessages([],[{role:'assistant',content:'你好',raw:[{type:'thinking',thinking:'x'}]}])[1]).not.toHaveProperty('reasoning_content');
 const acc=createAccumulator();acc.push({choices:[{message:{reasoning_content:'完整推理',tool_calls:[{id:'c',function:{name:'f',arguments:'{}'}}]}}]});
 expect(acc.result().raw).toEqual({kind:'openai',reasoning_content:'完整推理'});
 expect(createAccumulator().result()).not.toHaveProperty('raw');
});

it('事件流假连接失活时重连同一任务，不丢事件、不重复启动任务',async()=>{
 let n=0; const afters=[];
 const client={getTask:async()=>({status:'running',seq:1}),events:async(id,after)=>{
  afters.push(after);n++;
  if(n===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"seq":1,"type":"text","delta":"前半"}\n\n'));}}));
  return new Response('data: {"seq":2,"type":"task_state","status":"done","text":"前半后半"}\n\n');
 }};
 const got=[];
 const result=await followTask(client,'same-task',{onEvent:e=>got.push(e.seq),idleMs:15,checkMs:5,retryMs:[1]});
 expect(result.text).toBe('前半后半');expect(afters).toEqual([0,1]);expect(got).toEqual([1,2]);
});

it.each([401,403])('鉴权失败%s不无限重连，给出可操作原因',async status=>{
 let calls=0;
 await expect(followTask({events:async()=>{calls++;return new Response('',{status});}},'t',{retryMs:[1]})).rejects.toMatchObject({status});
 expect(calls).toBe(1);
});
it('预先取消不建立连接',async()=>{
 const c=new AbortController();c.abort();const events=vi.fn();
 await expect(followTask({events},'t',{signal:c.signal})).rejects.toMatchObject({name:'AbortError'});expect(events).not.toHaveBeenCalled();
});
