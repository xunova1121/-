import { it, expect } from 'vitest';
import { runAgent } from '../src/agent/agent.js';
import { createTimeCalcTool } from '../src/agent/timeCalc.js';
import { createVerificationTool } from '../src/agent/verifyNumbers.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { createTools } from '../src/agent/tools.js';
const now = Date.parse('2026-11-03T15:50:00+08:00');
const done = text => ({ text, toolCalls: [], stop: 'end_turn' });
const call = (name, action, data, id) => ({ text: '', toolCalls: [{ id: String(id), name, args: { action, data } }], stop: 'tool_use' });
const run = (adapter, tools) => runAgent({ adapter, tools, model: 'fixture', userText: '23小时后是几点', context: { dynamic: '' }, history: [], quiet: true, emit() {} });

it('注册新工具且time_calc成功回执计入计算核验', () => {
  expect(createTools({ now: () => now }).some(t => t.name === 'time_calc')).toBe(true);
  const review = createExecutionReview('23小时后是几点');
  review.record({ name: 'verify_numbers', ok: false, code: 'INVALID_FACT_INPUT' });
  review.record({ name: 'time_calc', ok: true });
  expect(review.report().calculation).toBe('tool_checked');
});
it('计算工具报错后改参数成功，真实回答不止搓搓手', async () => {
  let turn = 0;
  const adapter = { async stream() {
    if (++turn === 1) return call('time_calc', 'add', { date: '坏日期', hours: 23 }, turn);
    if (turn === 2) return call('time_calc', 'add', { date: '现在', hours: 23 }, turn);
    return done('按北京时间2026年11月3日15:50为基准，23小时后是11月4日星期三14:50。');
  } };
  const result = await run(adapter, [createTimeCalcTool({ now: () => now })]);
  expect(result.text).toContain('14:50');
  expect(result.review.calculation).toBe('tool_checked');
  expect(turn).toBe(3);
});
it('模型报错后只回搓搓手，最终必须有明确失败答复，不留空白', async () => {
  let turn = 0;
  const result = await run({ async stream() {
    if (++turn === 1) return call('time_calc', 'add', { date: '坏日期' }, turn);
    return done('搓搓手');
  } }, [createTimeCalcTool({ now: () => now })]);
  expect(turn).toBeLessThanOrEqual(3);
  expect(result.text).toContain('校验失败');
  expect(result.text).not.toBe('搓搓手');
});
it('旧工具失败后可改用time_calc成功，失败不能抹掉后续修正', async () => {
  let turn = 0;
  const result = await run({ async stream() {
    if (++turn === 1) return call('verify_numbers', 'date_add', { date: '坏日期', days: 0 }, turn);
    if (turn === 2) return call('time_calc', 'add', { date: '2026-11-03 15:50', hours: 23 }, turn);
    return done('11月4日14:50，星期三。');
  } }, [createVerificationTool(), createTimeCalcTool({ now: () => now })]);
  expect(result.text).toContain('14:50');
  expect(result.review.calculation).toBe('tool_checked');
});
it('工具仍失败时允许明确标记的推算，不冒充工具核验通过', async () => {
  let turn = 0;
  const result = await run({ async stream() {
    if (++turn <= 2) return call('time_calc', 'add', { date: '坏日期' + turn }, turn);
    return done('工具没能计算，以下按常识推算：以北京时间11月3日15:50为基准，加23小时是11月4日14:50。');
  } }, [createTimeCalcTool()]);
  expect(result.text).toContain('以下按常识推算');
  expect(result.review.calculation).toBe('failed');
  expect(result.review.outcome).not.toBe('passed');
});
