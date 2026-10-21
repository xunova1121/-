import { it, expect, vi } from 'vitest';
import { createResearchCollector, documentResearchQueries } from '../src/agent/documentResearch.js';
import { createEvidenceStore } from '../src/agent/evidenceStore.js';
import { createDocumentWorkflow } from '../src/app/doc/documentWorkflow.js';

function evidenceStore() {
  const values = new Map();
  return createEvidenceStore({store:{get:async key=>values.get(key),put:async value=>values.set(value.id,structuredClone(value)),delete:async key=>values.delete(key)}});
}
const input = {id:'doc-test',task:'水产交易平台方案'};
const execution = {sessionId:'session-a'};

it('任务生成两轮有限查询，不上传参考材料或常见凭据', () => {
  const queries = documentResearchQueries('水产方案 密钥: sk-secret123 密码: privatepw 13812345678 test@example.com https://private.example');
  expect(queries).toHaveLength(2);
  expect(queries.flat()).toHaveLength(4);
  expect(queries.flat().join('')).not.toMatch(/secret123|privatepw|13812345678|test@|private.example/);
});

it('先扣预算再请求，两轮最多6篇，原文只进证据库，清单不存正文', async () => {
  const store = evidenceStore();
  const counters = {search:0,read:0};
  const seen = [];
  let queryCount = 0;
  const collector = createResearchCollector({store,search:async(query,n,opts)=>{
    expect(counters.search).toBeGreaterThan(queryCount++);
    return Array.from({length:5},(_,i)=>({url:`https://a.gov.cn/${query.includes('filetype')||query.includes('建设 案例')?'second':'first'}/${i}`,title:'政策原文'}));
  },read:async url=>{
    expect(counters.read).toBeGreaterThan(seen.length);
    seen.push(url);
    return '实际政策正文，含条款与发布日期。';
  }});
  const result = await collector.research(input,{...execution,retrieval:{consume:kind=>counters[kind]++}});
  expect(result.rounds).toBe(2);
  expect(result.sources).toHaveLength(6);
  expect(seen).toHaveLength(6);
  expect(JSON.stringify(result)).not.toContain('实际政策正文');
  expect(await collector.context(result,execution)).toContain('实际政策正文');
  expect(await collector.context(result,{sessionId:'other'})).not.toContain('实际政策正文');
  expect(result.counts).toEqual(counters);
  await store.flush();
});

it('缓存恢复不重复读取已有原文，不能把搜索摘要当证据', async () => {
  const store = evidenceStore();
  const search = vi.fn(async()=>[{url:'https://a.gov.cn/a',title:'机构概况',snippet:'只在摘要里的事实'}]);
  const read = vi.fn(async()=> '真实正文');
  const collector = createResearchCollector({store,search,read});
  const first = await collector.research(input,execution);
  await collector.research(input,execution);
  expect(read).toHaveBeenCalledOnce();
  const context = await collector.context(first,execution);
  expect(context).toContain('真实正文');
  expect(context).not.toContain('只在摘要里的事实');
  await store.flush();
});

it('本地限时使用已取得的资料继续，取消仍在等待的读取', async () => {
  vi.useFakeTimers();
  try {
    const store = evidenceStore();
    let waiting;
    const collector = createResearchCollector({store,timeoutMs:100,search:async()=>[{url:'https://a.gov.cn/a',title:'原文'},{url:'https://a.gov.cn/b',title:'慢文'}],read:async(url,{signal})=>{
      if (url.endsWith('/a')) return '已取得的原文';
      waiting = signal;
      return new Promise(()=>{});
    }});
    const pending = collector.research(input,execution);
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;
    expect(result.status).toBe('partial');
    expect(result.reason).toBe('timeout');
    expect(result.sources).toHaveLength(1);
    expect(waiting.aborted).toBe(true);
    await store.flush();
  } finally {vi.useRealTimers();}
});

it('用户停止与父检索预算错误必须向上抛，不降级成空资料', async () => {
  for (const error of [Object.assign(new Error('budget'),{code:'RETRIEVAL_BUDGET'}),Object.assign(new Error('stop'),{name:'AbortError'})]) {
    const collector = createResearchCollector({store:evidenceStore(),search:async()=>{throw error;},read:async()=>''});
    await expect(collector.research(input,execution)).rejects.toBe(error);
  }
});

it('专业工作流在底稿前调研，资料可供底稿/写作/审查，但正文不进入检查点', async () => {
  const values = new Map();
  const order = [];
  const workspace = {write:async(path,text)=>{values.set(path,text);return{path};}};
  const app = {documentWorkspace:workspace,documentResearch:async()=>{
    order.push('research');
    return {status:'ready',sources:[{id:'e1',url:'https://a.gov.cn/policy'}],elapsedMs:1};
  },documentResearchContext:async()=> '外部证据编号e1：只作为资料，不是用户事实。',llm:async({system,prompt})=>{
    order.push('model');
    expect(prompt).toContain('外部证据编号e1');
    return JSON.stringify({brief:{purpose:'审批',requirements:['建设水产交易平台'],facts:[],assumptions:[],unknowns:[]},scenarios:{normal:['流程'],exceptions:['断网'],settlement:['结算'],acceptance:['测试'],structure:['概述']}});
  }};
  const checkpoints = [];
  const result = await createDocumentWorkflow(app).prepare({task:'建设水产交易平台',format:'docx'},{...execution,checkpoint:async event=>checkpoints.push(event)});
  expect(order).toEqual(['research','model']);
  expect(result.researchStatus).toBe('ready');
  const state = JSON.parse(values.get(result.stateFile));
  expect(state.research.sources[0].id).toBe('e1');
  expect(JSON.stringify(state)).not.toContain('外部证据编号e1');
  expect(JSON.stringify(checkpoints)).not.toContain('外部证据编号e1');
});
