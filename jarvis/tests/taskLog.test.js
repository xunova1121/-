import { describe, it, expect, beforeEach } from 'vitest';
import { runAgent } from '../src/agent/agent.js';
import { collection } from '../src/agent/store.js';

const events = collection('events');
beforeEach(async () => { for (const e of await events.all()) await events.delete(e.id); });

/** 假模型：按脚本依次返回工具调用，最后一步给文字 */
function scripted(steps) {
  let i = 0;
  return { async stream() { const s = steps[Math.min(i++, steps.length - 1)]; return s.calls ? { text: '', toolCalls: s.calls.map((name, k) => ({ id: `c${i}${k}`, name, args: {} })) } : { text: s.text, toolCalls: [] }; } };
}
const tools = [
  { name: 'ok_tool', input_schema: { type: 'object', properties: {} }, run: async () => '好了' },
  { name: 'bad_tool', input_schema: { type: 'object', properties: {} }, run: async () => { throw new Error('出错'); } }
];
const run = (adapter, maxSteps = 16) => runAgent({ adapter, model: 'x', history: [], userText: '做件事', tools, emit: () => {}, maxSteps, context: { dynamic: '', kbHits: [] } });
const kinds = async () => (await events.all()).map((e) => [e.kind, e.text]);

describe('任务日志', () => {
  it('工具都成功：记“完成任务”', async () => {
    await run(scripted([{ calls: ['ok_tool'] }, { text: '完成' }]));
    expect(await kinds()).toEqual([['task', '完成任务：做件事（调用工具 1 次）']]);
  });
  it('末尾工具成功不能证明先前失败已改正', async () => {
    await run(scripted([{ calls: ['bad_tool'] }, { calls: ['ok_tool'] }, { text: '完成' }]));
    expect(await kinds()).toEqual([['issue', '未完成任务：做件事（存在失败步骤，需要核实结果；工具 2 次，失败 1 次）']]);
  });
  it('最后一步工具失败：不记“完成任务”', async () => {
    await run(scripted([{ calls: ['bad_tool'] }, { text: '抱歉没做成' }]));
    const k = await kinds();
    expect(k.some(([kind]) => kind === 'task')).toBe(false);
    expect(k[0]).toEqual(['issue', '未完成任务：做件事（存在失败步骤，需要核实结果；工具 1 次，失败 1 次）']);
  });
  it('达到最大步数：不记“完成任务”', async () => {
    await run(scripted([{ calls: ['ok_tool'] }]), 3);
    const k = await kinds();
    expect(k.some(([kind]) => kind === 'task')).toBe(false);
    expect(k[0][1]).toMatch(/达到最大步数/);
  });
});
