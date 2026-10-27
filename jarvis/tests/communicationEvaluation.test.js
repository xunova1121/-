import { expect, it } from 'vitest';
import { communicationCases } from '../evals/communication-cases.mjs';
import { runCommunicationCase } from '../evals/communication.mjs';
it('真实评测协议按题隔离记忆、多轮同会话，执行成功也不能自动算语义通过', async () => {
  const cases = communicationCases.slice(1, 2),
    submitted = [];
  const api = async (route, body) => {
    if (route === '/api/tasks') {
      submitted.push(body);
      return { id: `task${submitted.length}`, sessionId: body.sessionId || 'session-a' };
    }
    if (route.startsWith('/api/tasks/')) return { status: 'done', timing: { modelCalls: 1, inputChars: 100 } };
    if (route.startsWith('/api/sessions/')) return { messages: [{ role: 'assistant', content: '测试答复' }] };
    throw new Error('不应使用其他接口');
  };
  const result = await runCommunicationCase(api, cases[0], { runId: 'independent-run' });
  expect(submitted).toHaveLength(2);
  expect(submitted[0].evaluationId).toBe('independent-run_care-02');
  expect(submitted[1]).toMatchObject({ sessionId: 'session-a', evaluationId: submitted[0].evaluationId });
  expect(result.quality).toBe('not_reviewed');
  expect(result.turns.every((t) => t.timing.modelCalls === 1)).toBe(true);
});
