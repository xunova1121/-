import { describe, it, expect } from 'vitest';
import { verifyNumbers, createVerificationTool } from '../src/agent/verifyNumbers.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { taskContract } from '../src/agent/taskContract.js';
import { runAgent } from '../src/agent/agent.js';

const request = '每箱毛重23.6公斤，筐重1.4公斤，共37箱，单价18.5元/公斤。算净重和货款，写出算式。';
const context = { dynamic: '' };
const done = text => ({ text, toolCalls: [], stop: 'end_turn' });
const call = data => ({ text: '', toolCalls: [{ id: Math.random().toString(36), name: 'verify_numbers', args: { action: 'weighing', data } }], stop: 'tool_use' });

describe('关键计算先核验再交付', () => {
  it('称重货款支持小数、箱数和合法零值，非法输入带错误类型', () => {
    expect(verifyNumbers('weighing', { gross: 23.6, tare: 1.4, count: 37, unitPrice: 18.5 })).toMatchObject({ netPerUnit: 22.2, net: 821.4, amount: 15195.9 });
    expect(verifyNumbers('weighing', { gross: 0, tare: 0 })).toMatchObject({ net: 0 });
    for (const data of [{ gross: 1, tare: 2 }, { gross: -1, tare: 0 }, { gross: Infinity, tare: 0 }, { gross: 10, tare: 1, count: 1.5 }, { gross: '10', tare: 0 }]) {
      try { verifyNumbers('weighing', data); throw new Error('应当拒绝'); } catch (error) { expect(error.code).toBe('INVALID_FACT_INPUT'); }
    }
  });
  it('净重、日期差和权重算数属于计算，不把不运行的代码解释变成执行任务', () => {
    for (const text of [request, '2024年2月28日到3月2日相隔几天', '18%、27%、55%的权重合计多少']) expect(taskContract(text).calculation).toBe(true);
    expect(taskContract('写JavaScript函数计算净重，给3个边界测试，只给代码不运行').calculation).toBe(false);
  });
  it('失败不能被之前成功的回执掩盖；最新纠正成功才能恢复', () => {
    const r = createExecutionReview(request);
    r.record({ name: 'verify_numbers', ok: true });
    r.record({ name: 'verify_numbers', ok: false });
    expect(r.report().calculation).toBe('failed');
    expect(r.guardsAnswer()).toBe(true);
    r.record({ name: 'verify_numbers', ok: true });
    expect(r.report().calculation).toBe('tool_checked');
  });
  it('失败后硬答的数值不发给用户；最多修正一次，仍未校验则明确人工复核', async () => {
    let calls = 0;
    const events = [];
    const adapter = { async stream({ onText }) {
      if (++calls === 1) return call({ gross: 1, tare: 2 });
      const text = '已通过校验，货款15195.9元';
      onText(text);
      return done(text);
    } };
    const r = await runAgent({ adapter, model: 'fixture', userText: request, history: [], tools: [createVerificationTool()], context, quiet: true, emit: e => events.push(e) });
    expect(calls).toBe(3);
    expect(r.text).toContain('校验失败，请人工复核');
    expect(r.text).not.toContain('15195.9');
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).not.toContain('已通过校验');
    expect(r.review.outcome).toBe('partial');
    expect(r.review.calculation).toBe('failed');
  });
  it('失败参数被纠正且工具实际成功后，交付核验结果', async () => {
    let calls = 0;
    const adapter = { async stream() {
      calls++;
      if (calls === 1) return call({ gross: 1, tare: 2 });
      if (calls === 2) return call({ gross: 23.6, tare: 1.4, count: 37, unitPrice: 18.5 });
      return done('净重821.4公斤，货款15195.9元。');
    } };
    const r = await runAgent({ adapter, model: 'fixture', userText: request, history: [], tools: [createVerificationTool()], context, quiet: true, emit() {} });
    expect(r.text).toContain('15195.9');
    expect(r.review.calculation).toBe('tool_checked');
    expect(r.review.outcome).not.toBe('partial');
  });
  it('没有计算工具时直接说明未核验，不白等多轮', async () => {
    let calls = 0;
    const adapter = { async stream() { calls++; return done('15195.9'); } };
    const r = await runAgent({ adapter, model: 'fixture', userText: request, history: [], tools: [], context, quiet: true, emit() {} });
    expect(calls).toBe(1);
    expect(r.text).toContain('尚未完成工具校验');
    expect(r.text).toContain('15195.9');
  });
});

describe('贴进来的长文不当成要算数', () => {
  it('交接记录里顺带有“重新计算摘要”“1624项”“0.78%”：不要求数值校验；长文开头就请你算的照旧要校验（用户 2026-10-26 遇到回答末尾多出“关键数值尚未完成工具校验”）', () => {
    const pasted = `# 给 AI 编程助手的说明\n${'1. 先读约定文档，再读交接记录。\n'.repeat(30)}最终全量179文件1624项全部通过；源稿重新计算摘要与实际交付相符；展示PPT通道差0.7816%、PDF0.5441%通过。`;
    expect(pasted.length).toBeGreaterThan(600);
    expect(taskContract(pasted).calculation).toBe(false);
    const ask = `帮我计算这份账单的合计金额：\n${'办公用品 120元，打印纸 35元\n'.repeat(30)}`;
    expect(taskContract(ask).calculation).toBe(true);
  });
});
