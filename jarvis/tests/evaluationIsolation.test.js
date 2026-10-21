import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend, collection } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { measureModelInput } from '../shared/modelMetrics.js';
import { createTaskTiming } from '../shared/taskTiming.js';
import { metricsFor } from '../evals/baseline-report.mjs';
import { baselineCases } from '../evals/baseline-cases.mjs';

it('正式input_schema参数参与字符测量，不计入工具实现', () => {
  const measured = measureModelInput({ tools: [{ name: 'demo', input_schema: { type: 'object', properties: { distinctiveField: { type: 'string' } } }, run: () => 'private' }] });
  expect(measured.toolSchemaChars).toBeGreaterThan(100);
  expect(Object.values(measured).every(Number.isFinite)).toBe(true);
});

it('存在分身调用时不把部分计数冒充全部模型调用数', () => {
  const timing = createTaskTiming(0, () => 1);
  timing.event({ type: 'diagnostic', phase: 'model_start', inputChars: 1 });
  timing.event({ type: 'tool_start', id: 'delegate', name: 'delegate_task' });
  const measured = metricsFor(baselineCases[0], [{ clientTotalMs: 1, timing: timing.snapshot() }]);
  expect(timing.snapshot().delegateTasks).toBe(1);
  expect(measured.mainModelCalls).toBe(1);
  expect(measured.allModelCalls).toBeNull();
});

it('评测真实任务不写正式记忆/任务日志，也不进入其他对话自动检索', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eval-isolation-'));
  useBackend(createFileStore(directory));
  let writes = 0;
  let calls = 0;
  const adapter = { kind: 'mock', async stream({ onText }) {
    if (++calls === 1) return { text: '', toolCalls: [{ id: 'remember-call', name: 'remember', args: { content: '虚构试验订单' } }], stop: 'tool_use' };
    onText?.('当前评测会话内保留。');
    return { text: '当前评测会话内保留。', toolCalls: [], stop: 'end_turn' };
  } };
  const runner = createTaskRunner({ getConfig: async () => ({ provider: 'mock', autoMemory: true }), makeAdapter: () => ({ adapter, model: 'test' }), makeTools: () => [{ name: 'remember', description: '测试记忆工具', input_schema: { type: 'object', properties: { content: { type: 'string' } } }, run: async () => { writes++; return '已写入'; } }] });
  try {
    const task = await runner.start({ text: '记住虚构试验订单', evaluationId: 'isolated-run', requestId: 'eval-request' });
    const deadline = Date.now() + 5000;
    while (['queued', 'running'].includes(runner.get(task.id).status)) {
      if (Date.now() > deadline) throw new Error('测试任务未收尾');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runner.settled();
    expect(runner.get(task.id).status).toBe('done');
    expect(writes).toBe(0);
    expect(await collection('memories').all()).toEqual([]);
    expect(await collection('events').all()).toEqual([]);
    expect((await sessions.get(task.sessionId)).evaluationId).toBe('isolated-run');
    expect(await sessions.recent()).toEqual([]);
    expect(await sessions.searchMessages('虚构试验订单')).toEqual([]);
    expect(await sessions.searchContent('虚构试验订单')).toEqual([]);
    await expect(runner.start({ sessionId: task.sessionId, text: '修改订单', evaluationId: 'different-run' })).rejects.toMatchObject({ status: 409 });
  } finally {
    for (const task of runner.list()) runner.stop(task.id);
    await runner.settled();
    useBackend(null);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
