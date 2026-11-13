import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { isRetrievalStop } from '../shared/retrievalStop.js';
import { createTaskTiming } from '../shared/taskTiming.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { failedStep } from '../src/agent/failedSteps.js';
import { createTurnEvents } from '../src/app/turnEvents.js';
import { runAgent } from '../src/agent/agent.js';
import { reusesPreSearch } from '../src/agent/preSearch.js';

vi.mock('../src/app/env.js', () => ({ now: () => 0, storage: undefined, toast: vi.fn(), markActivity: vi.fn() }));
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { delete globalThis.indexedDB; });

function fixture(closing = false) {
  const retrieval = createRetrievalBudget('今天新闻');
  const run = vi.fn(async (_args, options) => { options.retrieval.consume('read'); return '读回原文'; });
  const tool = { name: 'web_fetch', input_schema: { type: 'object', properties: {} }, run };
  const events = [], checkpoints = [];
  const options = {
    loader: { get: () => tool }, emit: event => events.push(event), seen: new Map(), closing,
    retrieval, review: { record() {}, report: () => ({ request: '今天新闻' }) },
    checkpoint: async event => checkpoints.push(event), webTools: new Set(['web_fetch']), parallelSafe: new Set(['web_fetch'])
  };
  return { events, checkpoints, run, options, retrieval, execute: calls => executeToolCalls(calls, options) };
}
const call = id => ({ id: String(id), name: 'web_fetch', args: {} });

it('模型不遵守正常收尾也不能耗尽整个循环；没有新资料时有界停止', async () => {
  let clockValue = 0;
  const timeline = [];
  const result = await runAgent({
    model: 'fixture', history: [], userText: '查比分', context: { dynamic: '' }, quiet: true,
    maxSteps: 40, timeBudgetMs: 60_000, now: () => clockValue++ * 20_000,
    tools: [{ name: 'web_search', description: 'fixture', input_schema: { type: 'object', properties: { q: { type: 'string' } } }, run: async () => '无可核实网页来源' }],
    adapter: { async stream() { return { text: '', toolCalls: [{ id: String(clockValue), name: 'web_search', args: { q: `第${clockValue}次` } }], stop: 'tool_use' }; } },
    emit: event => { if (event.type === 'tool_end' && timeline.length < 12) timeline.push({ ok: event.ok, code: event.code, output: event.output.slice(0, 100) }); }
  });
  expect(result.toolCalls).toBeLessThan(12);
  expect(result.steps).toBeLessThan(12);
  expect(timeline.some(event => event.code === 'RETRIEVAL_BUDGET')).toBe(true);
  expect(result.text).not.toMatch(/预算|本轮检索已停止|额度用完/);
  expect(result.text).toContain('还没有确切结果');
});

it('失败或空查询的预查回执不能伪装成成功缓存，合法相同查询仍复用', () => {
  const found = { tool: 'web_search', args: { query: '公司' }, query: '公司', output: '候选资料' };
  expect(reusesPreSearch({ name: 'web_search', args: { query: '公司' } }, found)).toBe(true);
  for (const state of ['failed', 'input']) expect(reusesPreSearch({ name: 'web_search', args: { query: '公司' } }, { ...found, recovery: { state } })).toBe(false);
  expect(reusesPreSearch({ name: 'web_search', args: { q: '别的问题' } }, { ...found, query: '' })).toBe(false);
});

it('已有合法预查结果，到收尾时重复缓存命中也不能绕过停止', async () => {
  let clockValue = 0, query = '';
  const run = vi.fn(async args => { query = args.query; return '电影今日票房为1亿元，来源：https://source.example/box-office'; });
  const result = await runAgent({
    model: 'fixture', history: [], userText: '今天电影票房多少', context: { dynamic: '' }, quiet: true,
    maxSteps: 40, timeBudgetMs: 2000, now: () => clockValue * 2000,
    tools: [{ name: 'web_search', description: 'fixture', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run }],
    adapter: { async stream() { clockValue++; return { text: '', toolCalls: [{ id: String(clockValue), name: 'web_search', args: { query: query || '今天电影票房' } }], stop: 'tool_use' }; } },
    emit: () => {}
  });
  expect(run).toHaveBeenCalledOnce();
  expect(result.steps).toBeLessThan(12);
  expect(result.toolCalls).toBeLessThan(12);
});

it('读满8条仍停止后续请求：并行的正常收尾保留类型与诊断，不伪装成功，不把内部原因给模型', async () => {
  const f = fixture();
  for (let n = 0; n < 8; n++) f.retrieval.consume('read');
  const results = await f.execute([call('one'), call('two')]);
  expect(f.run).toHaveBeenCalledTimes(1);
  for (const result of results) {
    expect(result.ok).toBe(false);
    expect(isRetrievalStop(result)).toBe(true);
    expect(result.output).not.toMatch(/错误：|8次|预算已用完/);
    expect(result.output).toContain('未执行的读取不能当作已读');
  }
  expect(f.retrieval.resources.read).toBe(8);
  expect(f.events.some(event => event.type === 'diagnostic' && event.reason.includes('8次'))).toBe(true);
  expect(f.checkpoints.filter(event => event.type === 'tool_end').every(event => event.code === 'RETRIEVAL_BUDGET')).toBe(true);
});

it('已有收尾状态不再执行工具，保留停止类型；次数不转成真实失败统计', async () => {
  const f = fixture(true);
  const [result] = await f.execute([call('closed')]);
  expect(f.run).not.toHaveBeenCalled();
  expect(result.failure.code).toBe('RETRIEVAL_BUDGET');
  const timing = createTaskTiming(0, () => 20);
  f.events.forEach(event => timing.event(event));
  expect(timing.finish()).toMatchObject({ toolCalls: 0, failedTools: 0 });
  expect(failedStep(f.events.find(event => event.type === 'tool_end'))).toBeNull();
  expect(isRetrievalStop({ code: 'EVAL_QUOTA' })).toBe(false);
  expect(failedStep({ name: 'web_fetch', code: 'NETWORK', output: '连接失败' })).toEqual({ tool: 'web_fetch', error: '连接失败' });
});

it.each([false, true])('当前/后台任务(%s)移除正常收尾卡片，不记失败；真实错误仍显示', background => {
  const turn = { steps: 2, background };
  const card = { omit: vi.fn(), done: vi.fn() };
  const cards = new Map([['one', card]]);
  const bubble = { status: vi.fn() };
  const app = { active: turn, hud: { toolOmit: vi.fn(), toolEnd: vi.fn(), think: vi.fn() }, panels: {} };
  const state = { usedTools: ['web_fetch', 'web_search'] };
  const handler = createTurnEvents(app).turnEvents(turn, state, { bubble, cards });
  handler({ type: 'tool_end', id: 'one', name: 'web_fetch', ok: false, code: 'RETRIEVAL_BUDGET' });
  expect(card.omit).toHaveBeenCalledOnce(); expect(card.done).not.toHaveBeenCalled();
  expect(turn.steps).toBe(1); expect(turn.failedSteps).toBeUndefined();
  expect(state.usedTools).toEqual(['web_search']);
  handler({ type: 'tool_end', id: 'one', name: 'web_fetch', ok: false, code: 'RETRIEVAL_BUDGET' });
  handler({ type: 'tool_end', id: 'plan', name: 'update_plan', ok: false, code: 'RETRIEVAL_BUDGET' });
  expect(turn.steps).toBe(1);
  expect(state.usedTools).toEqual(['web_search']);
  expect(card.omit).toHaveBeenCalledOnce();
  cards.set('two', card);
  handler({ type: 'tool_end', id: 'two', name: 'web_search', ok: false, code: 'NETWORK', output: '连接失败' });
  expect(card.done).toHaveBeenCalledWith(false, '连接失败', undefined);
  if (!background) expect(turn.failedSteps).toEqual([{ tool: 'web_search', error: '连接失败' }]);
});
