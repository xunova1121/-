/** “记住了”必须真的存进去：用户要她记住时没调记忆工具不能收尾；问有没有记住时先查 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { taskContract } from '../src/agent/taskContract.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { reviewOutcome } from '../src/agent/reviewOutcome.js';

const LESSON = '请记住这个教训：如果工具第一次生成失败，重试一次并成功就可以了。成功生成后，不需要反复读取整个文件去逐项核实。';

beforeEach(async () => {
  for (const key of ['memories', 'lessons', 'episodes', 'events', 'sessions']) await collection(key).clear();
  memory.configureMemory({});
});

describe('认出“要记住”和“问有没有记住”', () => {
  it('分得清', () => {
    expect(taskContract(LESSON)).toMatchObject({ remembering: true, askingMemory: false });
    expect(taskContract('记住，下次没有确认不要发')).toMatchObject({ remembering: true, askingMemory: false });
    expect(taskContract('你有放进记忆吗')).toMatchObject({ remembering: false, askingMemory: true });
    expect(taskContract('记住了吗？')).toMatchObject({ remembering: false, askingMemory: true });
    expect(taskContract('帮我做个Excel')).toMatchObject({ remembering: false, askingMemory: false });
  });
});

describe('没调记忆工具不能说记住了', () => {
  it('只回答“记住了”：收尾核对要求调用 remember，结果标为部分完成', () => {
    const review = createExecutionReview(LESSON);
    expect(review.required()).toBe(true);
    expect(review.guidance()).toContain('remember');
    const report = review.report();
    expect(report.memory).toBe('not_saved');
    expect(reviewOutcome(report).outcome).toBe('partial');
    review.record({ name: 'remember', args: { content: '生成成功后直接交付', category: 'lesson' }, ok: true });
    expect(review.report().memory).toBe('saved');
    expect(review.guidance()).toBe('');
  });
  it('调用失败不算记住', () => {
    const review = createExecutionReview(LESSON);
    review.record({ name: 'remember', args: { content: 'x' }, ok: false });
    expect(review.report().memory).toBe('not_saved');
  });
  it('问有没有记住：没 recall 先要求查', () => {
    const review = createExecutionReview('你有放进记忆吗');
    expect(review.guidance()).toContain('recall');
    review.record({ name: 'recall', args: { query: '教训' }, ok: true });
    expect(review.guidance()).toBe('');
  });
});

describe('做事方式的教训存进“经验教训”，查得到', () => {
  it('remember 的 lesson 类存成经验教训，recall 能查出来', async () => {
    const tools = createTools({ metrics: async () => ({}) });
    const remember = tools.find((t) => t.name === 'remember');
    const recall = tools.find((t) => t.name === 'recall');
    const out = await remember.run({ content: '文件生成成功、没有报错就直接交付，不要反复读取核实', category: 'lesson' });
    expect(out).toContain('经验教训');
    const all = await memory.listAll();
    expect(all.lessons.map((l) => l.content)).toContain('文件生成成功、没有报错就直接交付，不要反复读取核实');
    expect(all.memories).toHaveLength(0);
    expect(await recall.run({ query: '反复读取核实' })).toContain('[经验教训] 文件生成成功');
  });
});
