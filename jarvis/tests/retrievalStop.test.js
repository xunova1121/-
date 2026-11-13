import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { isRetrievalStop } from '../shared/retrievalStop.js';
import { createTaskTiming } from '../shared/taskTiming.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { failedStep } from '../src/agent/failedSteps.js';
import { createTurnEvents } from '../src/app/turnEvents.js';

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
  cards.set('two', card);
  handler({ type: 'tool_end', id: 'two', name: 'web_search', ok: false, code: 'NETWORK', output: '连接失败' });
  expect(card.done).toHaveBeenCalledWith(false, '连接失败', undefined);
  if (!background) expect(turn.failedSteps).toEqual([{ tool: 'web_search', error: '连接失败' }]);
});
