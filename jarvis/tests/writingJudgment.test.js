import { expect, it } from 'vitest';
import { WRITING_JUDGMENT } from '../src/app/doc/writingJudgment.js';
import { WRITING_RULES } from '../src/app/doc/workflowPolicy.js';
import { reviewDocument } from '../src/app/doc/contentReview.js';
import { reviseDocument } from '../src/app/doc/targetedRevision.js';
import { writeLongDocument } from '../src/agent/longDoc.js';
it('现有长文起草与读者审查共享判断指引，仍只有两节加一次通读', async () => {
  const calls = [];
  await writeLongDocument({
    task: '分析两种方案的取舍',
    title: '虚构方案',
    outline: [{ heading: '目标' }, { heading: '选型' }],
    llm: async (input) => {
      calls.push(input);
      if (input.system.includes('目标读者')) return JSON.stringify({ edits: [], issues: [] });
      const title = input.prompt.match(/现在只写第 \d+ 节「([^」]+)」/)?.[1];
      return `## ${title}\n\n依据用户提供的小团队规模，先做轻量试点并验证办理时间。\n<<<本节摘要>>>试点建议`;
    }
  });
  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.system.includes(WRITING_JUDGMENT))).toBe(true);
  expect(WRITING_RULES).toContain(WRITING_JUDGMENT);
});
it('审查能沿原流程指出缺依据与取舍并定点修正，不新增模型调用', async () => {
  const input = { task: '给小团队比较两种路线并推荐', format: 'md', material: '团队规模较小', role: 'solution' };
  const plan = { brief: { requirements: [{ id: 'REQ-1' }] } };
  const draft = '## 推荐\n\n我们打造先进高效的平台，全面提升水平。';
  const calls = [];
  const review = await reviewDocument(input, plan, draft, async (stage, args) => {
    calls.push(stage);
    expect(args.system).toContain(WRITING_JUDGMENT);
    return JSON.stringify({
      coverage: [{ id: 'REQ-1', result: 'partial', quote: '我们打造先进高效的平台' }],
      issues: [{ severity: 'must_fix', location: '推荐', problem: '未比较路线，也未解释推荐依据', fix: '结合团队规模给出两种路线和取舍' }]
    });
  });
  expect(review.outcome).toBe('needs_revision');
  const fixed = await reviseDocument(input, plan, draft, review, async (stage) => {
    calls.push(stage);
    return JSON.stringify({
      edits: [
        { find: '我们打造先进高效的平台，全面提升水平。', replace: '团队规模较小，建议先做轻量试点；整套平台覆盖更广但维护投入更大，待试点验证后再决定。' }
      ]
    });
  });
  expect(fixed).toContain('维护投入更大');
  expect(calls).toEqual(['reviewing', 'revising']);
});
