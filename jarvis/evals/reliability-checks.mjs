import test from 'node:test';
import assert from 'node:assert/strict';
import { runCase, serverAPI } from './runner.mjs';
import { baselineCases } from './baseline-cases.mjs';
import { checkResult, baselineSummary, compareBaseline } from './baseline-report.mjs';
import { recheckReport } from './baseline-review.mjs';
import { evaluationTools, bindEvaluation } from '../server/evaluation.mjs';

test('未明示的建议长度只能提示，不能将正确改写直接判错', () => {
  const result = checkResult(baselineCases[14], { status: 'done', answer: '礼貌催办。'.repeat(60) });
  assert.equal(result.mechanical, 'passed');
  assert.equal(result.quality, 'not_reviewed');
  assert.equal(result.warnings.length, 1);
});

test('待审题存在时准确率未知；全部已审失败才是零', () => {
  const pending = { status: 'done', quality: 'not_reviewed', metrics: {} };
  assert.equal(baselineSummary([pending]).verifiedPassRate, null);
  assert.equal(baselineSummary([{ ...pending, quality: 'failed' }]).verifiedPassRate, 0);
});

test('离线重判保留旧结果，不改题面或轮次，不把未看文件的题判为通过', () => {
  const original = { results: [{ id: 'baseline-15', status: 'done', quality: 'failed', assessment: { mechanical: 'failed' }, metrics: {}, turns: [{ status: 'done', answer: '催办。'.repeat(100) }] }] };
  const revised = recheckReport(original);
  assert.equal(revised.results[0].quality, 'not_reviewed');
  assert.equal(revised.results[0].previousAssessment.mechanical, 'failed');
  assert.equal(original.results[0].quality, 'failed');
  assert.deepEqual(revised.results[0].turns, original.results[0].turns);
});

test('最后轮询失败仍保留计时、文件、状态和安全错误类型', async () => {
  let polls = 0;
  const api = async (route) => {
    if (route === '/api/tasks') return { id: 't', sessionId: 's' };
    if (route.endsWith('/stop')) return { ok: true };
    if (++polls === 1) return { status: 'running', seq: 9, timing: { modelCalls: 7 }, files: ['partial.pptx'] };
    throw Object.assign(new Error('Bearer secret-response'), { code: 'ECONNRESET' });
  };
  const result = await runCase(api, baselineCases[24], { wait: async () => {} });
  assert.equal(result.timing.modelCalls, 7);
  assert.deepEqual(result.files, ['partial.pptx']);
  assert.equal(result.failure.kind, 'network');
  assert.equal(result.failure.phase, 'poll');
  assert.equal(result.lastTaskState.seq, 9);
  assert.equal(result.stopRequested, true);
  assert(!JSON.stringify(result).includes('secret-response'));
});

test('截止时轮询异常保留客户端超时，不改称模型超时', async () => {
  let time = 0;
  const api = async (route) => {
    if (route === '/api/tasks') return { id: 't', sessionId: 's' };
    if (route.endsWith('/stop')) return { ok: true };
    time = 2100;
    throw Object.assign(new Error('network'), { kind: 'timeout' });
  };
  const result = await runCase(api, { ...baselineCases[0], timeoutMs: 2000 }, { now: () => time });
  assert.equal(result.status, 'client_timeout');
  assert.equal(result.failure.kind, 'timeout');
  assert.equal(result.failure.phase, 'poll');
});

test('任务完成但取对话失败不抹去服务端done，也不停止已完成任务', async () => {
  let stops = 0;
  const api = async (route) => {
    if (route === '/api/tasks') return { id: 't', sessionId: 's' };
    if (route === '/api/tasks/t') return { status: 'done', timing: { modelCalls: 2 }, files: ['a.docx'] };
    if (route.endsWith('/stop')) stops++;
    throw Object.assign(new Error('credential'), { status: 502 });
  };
  const result = await runCase(api, baselineCases[17]);
  assert.equal(result.executionStatus, 'done');
  assert.equal(result.failure.phase, 'read_session');
  assert.equal(result.failure.httpStatus, 502);
  assert.equal(result.timing.modelCalls, 2);
  assert.equal(stops, 0);
});

test('客户端保留HTTP类型与状态，但不抛出上游正文', async () => {
  const api = serverAPI('https://example.test', 'private', async () => new Response('private upstream key', { status: 401 }));
  await assert.rejects(api('/x'), (error) => error.status === 401 && error.kind === 'api' && error.code === 'EVAL_HTTP' && !error.message.includes('private'));
});

test('评测记忆写工具不会调用正式实现，普通任务不受影响', async () => {
  let writes = 0;
  const original = [{ name: 'remember', run: async () => ++writes }];
  const isolated = evaluationTools(original, 'eval-one');
  assert.match(await isolated[0].run({ content: '虚构订单' }), /未写入/);
  assert.equal(writes, 0);
  await evaluationTools(original, null)[0].run();
  assert.equal(writes, 1);
  const session = { messages: [] };
  assert.equal(bindEvaluation(session, 'eval-one'), 'eval-one');
  session.messages.push({ role: 'user', content: '测试' });
  assert.equal(bindEvaluation(session, null), 'eval-one');
  assert.throws(() => bindEvaluation(session, 'eval-two'));
  assert.throws(() => bindEvaluation({ messages: [{}] }, 'eval-one'));
  assert.throws(() => bindEvaluation({ messages: [] }, 123));
});

test('评测隔离方式或评分规则变化后不宣称严格可比', () => {
  const report = { suiteVersion: 'v1', provider: 'deepseek', model: 'x', location: 'x', executionProfile: 'legacy', assessmentVersion: 'v1', results: [] };
  assert.equal(compareBaseline(report, { ...report, executionProfile: 'isolated' }).comparable, false);
  assert.equal(compareBaseline(report, { ...report, assessmentVersion: 'v2' }).comparable, false);
});
