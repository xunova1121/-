import { it, expect } from 'vitest';
import { dialoguePolicy } from '../src/agent/dialoguePolicy.js';
import { conciseTool } from '../src/agent/toolDescriptions.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { writeLongDocument, readerTest } from '../src/agent/longDoc.js';
import { STABLE_PROMPT, INFO_PROMPT } from '../src/agent/agent.js';

it('固定提示减半，保留授权、原话、文件和表情禁令；领域规则按本轮选择', () => {
  expect(STABLE_PROMPT.length).toBeLessThan(3200);
  expect(INFO_PROMPT.length).toBeLessThan(STABLE_PROMPT.length);
  for (const key of ['原始要求','授权','read_task_requirements','read_tool_result','不要换 run_python 硬读','不写表情标签']) expect(STABLE_PROMPT).toContain(key);
  expect(dialoguePolicy('你好')).not.toMatch(/T\+1|孕周|lowMemory/);
  expect(dialoguePolicy('A股今天买入是否能卖出')).toContain('T+1');
  expect(dialoguePolicy('计算孕周和日期')).toContain('verify_numbers');
  expect(dialoguePolicy('又闪退了')).toContain('lowMemory=false');
  expect(dialoguePolicy('明天天气下雨吗')).toContain('旧记忆不能证明今天的天气');
});

it('说明瘦身不改名称/schema/执行器，不改未知工具或原对象', () => {
  const run = () => 'ok';
  const tool = {name:'create_document',description:'旧说明'.repeat(200),input_schema:{type:'object'},run};
  const result = conciseTool(tool);
  expect(result.description.length).toBeLessThan(tool.description.length);
  expect(result.input_schema).toBe(tool.input_schema);
  expect(result.run).toBe(run);
  expect(tool.description).toContain('旧说明');
  const external = {name:'mcp_example',description:'外部说明'};
  expect(conciseTool(external)).toBe(external);
  const inherited = {name:'constructor',description:'原说明'};
  expect(conciseTool(inherited)).toBe(inherited);
});

it('纯问答和只检索不启动交付验收；明确交付与实际写入仍核验', () => {
  const chat = createExecutionReview('江苏供销概况');
  chat.record({name:'web_search',ok:true});
  expect(chat.required()).toBe(false);
  expect(chat.contractNote()).toBe('');
  const document = createExecutionReview('写一份Word方案');
  expect(document.required()).toBe(true);
  expect(document.guidance()).toContain('没有有效产物');
  const edited = createExecutionReview('改一下');
  edited.record({name:'write_file',args:{path:'app.js'},ok:true});
  expect(edited.required()).toBe(true);
  expect(edited.guidance()).toContain('没有实际运行');
});

it('长文只通读一次，同时修正术语和检查内容', async () => {
  const calls = [];
  const result = await writeLongDocument({task:'写方案',title:'方案',outline:[{heading:'一、目标'},{heading:'二、执行'}],llm: async ({system,prompt}) => {
    calls.push({system,prompt});
    if (system.includes('目标读者')) return JSON.stringify({edits:[{find:'原始方案术语',replace:'统一方案术语'}],issues:[]});
    const title = prompt.match(/现在只写第 \d+ 节「([^」]+)」/)?.[1];
    return `## ${title}\n\n原始方案术语及具体流程。\n<<<本节摘要>>>已写流程`;
  }});
  expect(calls).toHaveLength(3);
  expect(calls.filter(x=>x.system.includes('目标读者'))).toHaveLength(1);
  expect(result.edits).toBe(1);
  expect(result.markdown).toContain('统一方案术语');
  expect(result.review.failed).not.toBe(true);
});

it('无效审查不标通过；停止和预算不能被合并通读吞掉', async () => {
  expect(await readerTest({title:'a',task:'b',body:'正文',llm:async()=> '{}'})).toHaveProperty('failed',true);
  for (const error of [Object.assign(new Error('budget'),{code:'RETRIEVAL_BUDGET'}),Object.assign(new Error('stop'),{name:'AbortError'})]) {
    await expect(readerTest({title:'a',task:'b',body:'正文',llm:async()=>{throw error;}})).rejects.toBe(error);
  }
});
