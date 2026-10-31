import { it, expect } from 'vitest';
import { documentWordBudget, budgetSections } from '../src/agent/documentWordBudget.js';
import { writeLongDocument } from '../src/agent/longDoc.js';

it('明确范围优先于模型工具参数，短方案不拆成每节两千字', () => {
  expect(documentWordBudget('写1500～2500字的建设方案', 10000)).toMatchObject({ target: 2000, compact: true });
  expect(documentWordBudget('写20000字以内的报告')).toMatchObject({ target: 17000, compact: false });
  const sections = budgetSections([{ heading: '一', words: 1500 }, { heading: '二', words: 1500 }], 2000, '方案');
  expect(sections.reduce((sum, s) => sum + s.words, 0)).toBe(1998);
});
it('长材料不能覆盖用户篇幅，分节提示实际带预算', async () => {
  const prompts = [];
  await writeLongDocument({ task: '只按材料写1500至2500字', material: '甲'.repeat(7000), title: '方案', outline: [{ heading: '背景' }, { heading: '做法' }, { heading: '验收' }], review: false, llm: async ({ prompt }) => { prompts.push(prompt); return prompt.includes('输出JSON') ? '{"edits":[]}' : '正文内容'; } });
  expect(prompts[0]).toContain('约 666 字');
  expect(prompts[0]).not.toContain('宁多勿少');
  expect(prompts[0]).toContain('全文1500至2500字');
});
