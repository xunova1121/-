import { assertDiagramTarget } from '../src/agent/diagramTarget.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
import { it, expect } from 'vitest';
import { planDiagramContent } from '../src/agent/diagramPlanning.js';
import { createDiagramRecovery } from '../src/agent/diagramRecovery.js';
import { runAgent } from '../src/agent/agent.js';
const input={title:'虚构平台',layers:[{title:'感知',nodes:[{id:'a',title:'雷达8套'}]}]};
const fact={text:'雷达8套',source:'材料.md',excerpt:'配置雷达8套'};
const materials=[{path:'材料.md',text:'配置雷达8套'}];
it('严格事实校验保持，定位来源、摘录、事实和漏画字段',()=>{
  for(const [item,body,stage] of [[{...fact,source:'旧材料.md'},input,'source'],[{...fact,excerpt:'虚构的配置雷达8套'},input,'excerpt'],[{...fact,text:'雷达9套'},input,'fact'],[fact,{...input,layers:[{title:'感知',nodes:[{id:'a',title:'其他'}]}]},'inclusion']]){
    try{planDiagramContent({...body,contentPlan:{facts:[item]}},materials);throw Error('未拦截');}
    catch(e){expect(e.code).toBe('DIAGRAM_CONTENT_PLAN');expect(e.diagnostics[0]).toMatchObject({stage,field:expect.stringContaining('facts[0]')});}
  }
  expect(planDiagramContent({...input,contentPlan:{facts:[fact]}},materials).facts[0].included).toBe(true);
});
it('小改参数与换格式不能绕阶段限制，网络/控制不计，轮次可隔离',()=>{
  const state=createDiagramRecovery();const e=Object.assign(new Error('mismatch'),{code:'DIAGRAM_CONTENT_PLAN',kind:'input',diagnostics:[{stage:'excerpt'}]});
  for(const [i,ext] of ['svg','png','pdf'].entries())expect(state.record('create_diagram',{path:'图.'+ext,title:String(i)},e).stopped).toBe(i===2);
  const other=createDiagramRecovery();
  expect(other.record('create_diagram',{},Object.assign(new Error('offline'),{kind:'network',code:'HTTP'}))).toBeNull();
  expect(other.record('create_diagram',{},new DOMException('stop','AbortError'))).toBeNull();
  expect(other.record('read_file',{},e)).toBeNull();
  state.reset();expect(state.record('create_diagram',{path:'图.svg'},e).failures).toBe(1);
});
it('真实主循环变参数连续失败3次即结束，不额外请求模型空转',async()=>{
  let calls=0,runs=0;const events=[];
  const result=await runAgent({model:'fixture',quiet:true,context:{dynamic:''},userText:'制作虚构架构图',history:[],maxSteps:30,
    adapter:{async stream(o){calls++;if(calls>1)expect(o.messages.at(-1).content).toContain('定点修复');return {text:'',stop:'tool_use',toolCalls:[{id:'c'+calls,name:'create_diagram',args:{path:'测试.svg',title:String(calls)}}]};}},
    tools:[{name:'create_diagram',description:'fixture',input_schema:{type:'object',properties:{path:{type:'string'},title:{type:'string'}}},run:async()=>{runs++;throw Object.assign(new Error('摘录不在所选正文'),{code:'DIAGRAM_CONTENT_PLAN',kind:'input',diagnostics:[{field:'contentPlan.facts[0].excerpt',stage:'excerpt',action:'读确切来源再摘录'}]});}}],emit:e=>{if(e.type==='tool_end')events.push(e);}});
  expect(calls).toBe(3);expect(runs).toBe(3);expect(events).toHaveLength(3);expect(result.text).toContain('原文摘录');expect(result.text).toContain('已停止');
});

it('明确文件名不能用旧图的子串绕过版本选择',()=>{
  expect(()=>assertDiagramTarget('图.svg','检查 `旧图.svg`')).toThrow(/明确文件名/);
  expect(()=>assertDiagramTarget('图.svg','检查[原图](旧图.svg)')).toThrow();
  expect(()=>assertDiagramTarget('图.svg','检查[原图](图.svg)')).not.toThrow();
});
it('读取选定材料，按字段提示修复后实际生成SVG，原材料不被改写',async()=>{
  await workspace.write('恢复来源.md','配置雷达8套');
  await workspace.write('旧来源.md','配置雷达9套');
  const tool=createDiagramTool({});
  const body={...input,path:'恢复成功.svg',sources:[{path:'恢复来源.md',excerpt:'配置雷达8套'}],contentPlan:{facts:[{...fact,source:'恢复来源.md',excerpt:'配置雷达9套'}]}};
  await expect(tool.run(body)).rejects.toMatchObject({code:'DIAGRAM_CONTENT_PLAN',diagnostics:[{stage:'excerpt',field:'contentPlan.facts[0].excerpt',action:expect.any(String)}]});
  body.contentPlan.facts[0].excerpt='配置雷达8套';
  const receipt=await tool.run(body);
  expect(receipt).toContain('恢复成功.svg');
  expect(await workspace.readText('恢复成功.svg')).toContain('雷达8套');
  expect(await workspace.readText('恢复来源.md')).toBe('配置雷达8套');
  expect(await workspace.readText('旧来源.md')).toBe('配置雷达9套');
});
it('改输出名也有整轮上限，真实成功只重置同目标连续失败，不清空总预算',()=>{
  const state=createDiagramRecovery();const e=Object.assign(new Error('invalid'),{code:'DIAGRAM_INPUT',kind:'input'});
  for(let i=0;i<6;i++)expect(state.record('create_diagram',{path:`不同${i}.svg`},e).stopped).toBe(i===5);
  const fresh=createDiagramRecovery();fresh.record('create_diagram',{path:'甲.svg'},e);fresh.record('create_diagram',{path:'甲.svg'},e);
  fresh.record('read_file',{path:'甲.svg'},null);
  expect(fresh.record('create_diagram',{path:'甲.svg'},e).stopped).toBe(true);
  fresh.reset();fresh.record('create_diagram',{path:'甲.svg'},e);fresh.record('create_diagram',{path:'甲.svg'},null);
  expect(fresh.record('create_diagram',{path:'甲.svg'},e).failures).toBe(1);
});
it('达到上限时同批后续副作用不执行，用户插话后能恢复且工具响应配对完整',async()=>{
  const inbox=[];let calls=0,runs=0,writes=0;
  const result=await runAgent({model:'fixture',quiet:true,context:{dynamic:''},userText:'制作虚构图',history:[],maxSteps:20,inbox,emit:()=>{},
    adapter:{kind:'mock',async stream(o){calls++;if(calls===4){expect(o.messages.filter(m=>m.role==='tool').some(m=>m.toolCallId==='unused')).toBe(true);return{text:'按最新要求继续，未执行无关写入。',toolCalls:[],stop:'end_turn'};}return{text:'',toolCalls:[{id:'g'+calls,name:'create_diagram',args:{path:'同目标.svg',title:String(calls)}},...(calls===3?[{id:'unused',name:'write_file',args:{}}]:[])],stop:'tool_use'};}},
    tools:[{name:'create_diagram',description:'x',input_schema:{type:'object'},run:async()=>{runs++;if(runs===3)inbox.push('改为先解释已经定位的错误，不继续制作');throw Object.assign(new Error('invalid'),{code:'DIAGRAM_INPUT',kind:'input'});}},{name:'write_file',description:'x',input_schema:{type:'object'},run:async()=>{writes++;return'ok';}}]});
  expect(runs).toBe(3);expect(writes).toBe(0);expect(calls).toBe(4);expect(result.text).toContain('最新要求');
});

it('一次列出多条事实的错误位置，避免逐条试错消耗恢复次数',()=>{
  try { planDiagramContent({...input,contentPlan:{facts:[{...fact,source:'缺失.md'},{...fact,text:'雷达9套'}]}},materials);throw Error('未拦截'); }
  catch(error){expect(error.diagnosticCount).toBe(2);expect(error.diagnostics.map(item=>item.field)).toEqual(['contentPlan.facts[0].source','contentPlan.facts[1].text']);}
});

it('同底稿的不同输出目标不会互相累计连续失败',()=>{
 const state=createDiagramRecovery();const error=Object.assign(new Error('invalid'),{code:'DIAGRAM_INPUT',kind:'input'});
 expect(state.record('create_diagram',{path:'总体.svg',architecturePath:'同底稿.architecture.json'},error).failures).toBe(1);
 expect(state.record('create_diagram',{path:'业务.svg',architecturePath:'同底稿.architecture.json'},error).failures).toBe(1);
});

it('被用户否定的旧图不是允许目标，明确新图仍可读取',()=>{
 expect(()=>assertDiagramTarget('图.svg','不要检查 `旧图.svg`，请检查图.svg')).not.toThrow();
 expect(()=>assertDiagramTarget('旧图.svg','检查 `图.svg`，不是 `旧图.svg`')).toThrow();
 expect(()=>assertDiagramTarget('图.svg','检查 `图.svg`，不是 `旧图.svg`')).not.toThrow();
 expect(()=>assertDiagramTarget('旧图.svg','不要检查 `旧图.svg`')).toThrow();
 expect(()=>assertDiagramTarget('图.svg','不要改动直接检查 `图.svg`')).not.toThrow();
 expect(()=>assertDiagramTarget('图.svg','不要使用 `图.svg`，还是用 `图.svg`')).not.toThrow();
 expect(()=>assertDiagramTarget('0.svg',Array.from({length:33},(_,i)=>'`'+i+'.svg`').join('，'))).toThrow(/32/);
});
