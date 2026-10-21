import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineCases, suiteVersion } from './baseline-cases.mjs';
import { checkResult, metricsFor, compareBaseline } from './baseline-report.mjs';
import { runBaselineCase, validateBaselineConfig } from './baseline.mjs';
import { createTaskTiming } from '../shared/taskTiming.js';
import { applyReviews } from './baseline-review.mjs';

test('固定30题覆盖实时、政务、文档、计算与多轮；每题可复核', () => {
  assert.equal(baselineCases.length, 30);
  assert.equal(new Set(baselineCases.map((item) => item.id)).size, 30);
  for (const category of ['chat', 'knowledge', 'live', 'government', 'calculation', 'rewrite', 'translation', 'short_document', 'long_document', 'excel', 'ppt', 'correction', 'code']) {
    assert(baselineCases.some((item) => item.category === category));
  }
  assert(baselineCases.every((item) => item.rubric.length && item.checks));
  assert.equal(baselineCases.filter((item) => item.followup).length, 3);
});

test('机械满足不能冒充语义通过，缺少真实产物明确失败', () => {
  const item = baselineCases[17];
  assert.equal(checkResult(item, { status: 'done', answer: '已完成', files: ['a.docx'] }).quality, 'not_reviewed');
  assert.equal(checkResult(item, { status: 'done', answer: '已完成a.docx', files: [] }).quality, 'failed');
  assert.equal(checkResult(baselineCases[8], { status: 'done', answer: '这是概况' }).quality, 'failed');
});

test('输入字符缺样本不记零；主循环与所有模型计数分开', () => {
  const timing = createTaskTiming(0, () => 1);
  timing.start();
  timing.event({ type: 'diagnostic', phase: 'model_start', inputChars: 120 });
  assert.equal(timing.snapshot().inputChars, 120);
  timing.event({ type: 'diagnostic', phase: 'model_start' });
  assert.equal(timing.snapshot().inputChars, null);
  const metrics = metricsFor(baselineCases[0], [{ clientTotalMs: 5, timing: timing.snapshot() }]);
  assert.equal(metrics.mainModelCalls, 2);
  assert.equal(metrics.mainInputChars, null);
  assert.equal(metrics.allModelCalls, 2);
  timing.event({ type: 'diagnostic', phase: 'helper_start', inputChars: 45 });
  assert.equal(timing.snapshot().helperModelCalls, 1);
  assert.equal(timing.snapshot().helperInputChars, 45);
});

test('纠正必须提交到原sessionId，绝不新开会话冒充多轮', async () => {
  let submissions = 0;
  const bodies = [];
  const api = async (route, body) => {
    if (route === '/api/tasks') {
      submissions++;
      bodies.push(body);
      return { id: `task${submissions}`, sessionId: 'sameSession' };
    }
    if (route.startsWith('/api/tasks/')) return { status: 'done', timing: { modelCalls: 1, inputChars: 10 } };
    return { messages: [{ role: 'assistant', content: '周三A会议室' }] };
  };
  const result = await runBaselineCase(api, baselineCases[25]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].sessionId, 'sameSession');
  assert.notEqual(bodies[0].requestId, bodies[1].requestId);
  assert.equal(result.quality, 'not_reviewed');
  assert.equal(result.metrics.mainModelCalls, 2);
});

test('配置预检拒绝第三方、分工、未明确型号与收费搜索', () => {
  const cfg = { provider: 'deepseek', models: { deepseek: 'deepseek-chat' } };
  assert.equal(validateBaselineConfig(cfg).model, 'deepseek-chat');
  for (const patch of [{ provider: 'mock' }, { routing: { enabled: true } }, { models: {} }, { bochaKey: 'masked' }]) {
    assert.throws(() => validateBaselineConfig({ ...cfg, ...patch }));
  }
});

test('未评审、题集不同、混合模型不得宣称对比通过；已通过题退步拒收', () => {
  const report = { suiteVersion, provider: 'deepseek', model: 'deepseek-chat', location: 'https://example.test', results: baselineCases.map((item) => ({ id: item.id, status: 'done', quality: 'passed', metrics: {} })) };
  assert.equal(compareBaseline(report, structuredClone(report)).decision, 'no_quality_regression');
  const current = structuredClone(report);
  current.results[0].quality = 'failed';
  assert.equal(compareBaseline(report, current).decision, 'reject_regression');
  current.results[0].quality = 'not_reviewed';
  assert.equal(compareBaseline(report, current).decision, 'blocked_pending_comparable_review');
  assert.equal(compareBaseline(report, { ...report, model: 'other' }).comparable, false);
  assert.equal(compareBaseline(report, { ...report, mixedModel: true }).comparable, false);
});

test('审查须逐检查点给依据，不能把机械失败或缺项盖章通过', () => {
  const result = { id: 'x', status: 'done', quality: 'not_reviewed', assessment: { mechanical: 'passed' }, rubric: ['核对原文'], metrics: {} };
  const report = { results: [result] };
  const review = { id: 'x', quality: 'passed', checkpoints: [{ passed: true, evidence: '已逐项核对原始来源与回答，事实一致' }] };
  assert.equal(applyReviews(report, [review]).summary.passed, 1);
  assert.equal(report.results[0].quality, 'not_reviewed');
  assert.throws(() => applyReviews(report, [{ ...review, checkpoints: [] }]));
  assert.throws(() => applyReviews(report, [review, review]));
  assert.throws(() => applyReviews({ results: [{ ...result, status: 'error' }] }, [review]));
});
