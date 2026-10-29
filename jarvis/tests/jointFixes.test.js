/** 第一轮 30 题后的 8 项修正：评测读隔离、评审换模型、证据进评审提示、补救成功不报失败、决策题算账、改字号时文档工具常驻 */
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import * as sessions from '../src/agent/sessions.js';
import * as memory from '../src/agent/memory.js';
import { buildContext } from '../src/agent/agent.js';
import { evaluationTools } from '../server/evaluation.mjs';
import { judgeConfig, availableModels } from '../evals/joint-judge.mjs';
import { judgePrompt } from '../evals/joint-rubric.mjs';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { taskContract } from '../src/agent/taskContract.js';
import { withDocumentStyles } from '../src/agent/documentStyles.js';

describe('评测会话不读用户个人信息（第一轮：叫出“长乐”、引用真实产检报告、用上真实字号偏好）', () => {
  it('上下文里没有核心记忆里的用户信息和基本情况', async () => {
    await memory.setCore('human', '用户叫测试长乐，住南京');
    await memory.remember('用户的老婆在孕期', 'profile', { importance: 5 });
    const s = sessions.create();
    await sessions.save(s);
    const normal = await buildContext('你好', { sessionId: s.id, turns: 0 });
    const isolated = await buildContext('你好', { sessionId: s.id, turns: 0, isolated: true });
    expect(normal.dynamic).toContain('测试长乐');
    expect(isolated.dynamic).not.toContain('测试长乐');
    expect(isolated.dynamic).not.toContain('孕期');
    expect(isolated.dynamic).toContain('评测会话');
    expect(isolated.memories).toEqual([]);
  });
  it('查记忆、旧对话、持仓、知识库的工具在评测里被拦下；普通会话不受影响', async () => {
    const tools = ['recall', 'search_conversations', 'list_holdings', 'kb_search', 'web_search'].map((name) => ({ name, run: async () => '真实数据' }));
    const isolated = evaluationTools(tools, 'eval-1');
    for (const t of isolated.slice(0, 4)) expect(await t.run({})).toMatch(/评测隔离/);
    expect(await isolated[4].run({})).toBe('真实数据');
    expect(await evaluationTools(tools, null)[0].run({})).toBe('真实数据');
  });
  it('文档写作提示里也不再附真实偏好（调用方给了空偏好时）', async () => {
    const seen = [];
    const ctx = withDocumentStyles({ documentStylePreferences: async () => '', llm: async (r) => { seen.push(r.prompt); return 'ok'; } }, async () => '【用户历史写作偏好】正文四号');
    await ctx.llm({ prompt: '写' });
    expect(seen[0]).toBe('写');
    expect(await ctx.documentStylePreferences()).toBe('');
  });
});

describe('评审员：默认挑和答题不同、看着最强的模型；看得到证据', () => {
  const cfg = { provider: 'custom', models: { custom: 'gpt-6-luna' }, keys: { custom: 'k' }, abilities: { write: { main: { provider: 'custom', model: 'gpt-6.1-sol' } } } };
  it('和答题模型相同就换一个', () => {
    expect(availableModels(cfg).map((l) => l.model)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(judgeConfig(cfg, '', 'gpt-6-luna').models.custom).toBe('gpt-6.1-sol');
    expect(judgeConfig(cfg, 'custom::gpt-6-luna', 'gpt-6-luna').models.custom).toBe('gpt-6-luna'); // 显式指定照用
  });
  it('评审提示里有每轮用的工具、文件读回内容和建好的提醒，并说明以证据为准', () => {
    const p = judgePrompt({ id: 'joint-07', group: 'calculation', rubric: ['运算工具核对'] }, {
      turns: [{ prompt: '算', answer: '821.4' }],
      evidence: [{ tools: [{ name: 'verify_numbers', calls: 1, failed: 0 }], files: [{ path: 'a.xlsx', rows: 4, formulas: 3 }] }],
      createdSchedules: [{ title: '喝水', at: 1 }]
    });
    expect(p.prompt).toContain('verify_numbers');
    expect(p.prompt).toContain('"formulas":3');
    expect(p.prompt).toContain('喝水');
    expect(p.system).toContain('以【程序记录的证据】为准');
  });
});

describe('改原文件失败、另存新版成功：不再挂“这些操作没成功”', () => {
  it('同格式的文档后来生成成功就算补救了', () => {
    const review = createExecutionReview('字再小一点');
    review.record({ name: 'edit_office_document', args: { path: 'a/广告.docx' }, ok: false });
    review.record({ name: 'create_document', args: { path: 'a/广告-小字版.docx' }, ok: true });
    expect(review.report().failures).toEqual([]);
  });
  it('后面没有补救成功的照旧报', () => {
    const review = createExecutionReview('字再小一点');
    review.record({ name: 'edit_office_document', args: { path: 'a/广告.docx' }, ok: false });
    expect(review.report().failures).toEqual(['edit_office_document']);
  });
});

describe('带数字的“选哪个 / 划算吗”要用工具算（第一轮：结论对、差额算错）', () => {
  it('认得出来，普通问题不误伤', () => {
    expect(taskContract('两个方案：A一次投入20万，每月省1万；B每月租金8千，不用投入。用两年，选哪个？').calculation).toBe(true);
    expect(taskContract('买房还是租房划算？月租3000，房价200万').calculation).toBe(true);
    expect(taskContract('哪个好看').calculation).toBe(false);
    expect(taskContract('这件衣服好看吗，199元').calculation).toBe(false);
  });
});
