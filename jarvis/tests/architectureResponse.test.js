import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { architectureContentResponse } from '../src/agent/architectureResponse.js';
import { createArchitectureWorkflowTool } from '../src/agent/architectureWorkflow.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-reply-'));
  useBackend(createFileStore(root));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(root, { recursive: true, force: true });
});
const job = '文档检查/架构任务/test.json';
const materials = [{ path: '原文.md', text: '原文内容' }];
it('JSON坏格式保留原始回复、停止类型；下次只修格式，不重发原文，修后仍用后续严格编译', async () => {
  const state = { attempts: 0, request: '测试', lastError: null };
  const broken = '{"title":"示例" "entities":[]}';
  const llm = vi
    .fn()
    .mockResolvedValueOnce({ text: broken, stop: 'end_turn' })
    .mockResolvedValueOnce({ text: '{"title":"示例","entities":[]}', stop: 'end_turn' });
  const save = vi.fn();
  await expect(architectureContentResponse({ llm }, state, job, materials, save)).rejects.toHaveProperty('code', 'ARCHITECTURE_CONTENT_FORMAT');
  expect(await ws.readText(state.responsePath)).toBe(broken);
  expect(JSON.parse(await ws.readText(state.responseMetaPath)).stop).toBe('end_turn');
  expect(state.formatPending).toBe(true);
  expect(await architectureContentResponse({ llm }, state, job, materials, save)).toEqual({ title: '示例', entities: [] });
  const first = JSON.parse(llm.mock.calls[0][0].prompt),
    second = JSON.parse(llm.mock.calls[1][0].prompt);
  expect(first.materials[0].blocks[0]).toEqual({ block: 0, text: '原文内容' });
  expect(second.invalidJson).toBe(broken);
  expect(second).not.toHaveProperty('materials');
  expect(state.formatPending).toBe(false);
});
it('截断、超限回复保留回执而拒绝，禁止补括号硬通过', async () => {
  for (const response of [
    { text: '{}', stop: 'max_tokens' },
    { text: '甲'.repeat(80001), stop: 'end_turn' }
  ]) {
    const state = { attempts: 0, request: '测试' };
    await expect(architectureContentResponse({ llm: async () => response }, state, job, materials, async () => {})).rejects.toHaveProperty(
      'code',
      'ARCHITECTURE_CONTENT_TRUNCATED'
    );
    expect(state.formatPending).toBe(false);
    const meta = JSON.parse(await ws.readText(state.responseMetaPath));
    expect(meta.chars).toBe(response.text.length);
    expect(meta.capturedChars).toBeLessThanOrEqual(80000);
  }
});
it('请求前扣预算；停止、额度和3次上限不增加调用', async () => {
  const llm = vi.fn(async () => 'bad');
  const state = { attempts: 0, request: '测试' };
  const consume = vi.fn(() => {
    throw Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
  });
  await expect(architectureContentResponse({ llm }, state, job, materials, async () => {}, { retrieval: { consume } })).rejects.toHaveProperty(
    'code',
    'RETRIEVAL_BUDGET'
  );
  expect(llm).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(architectureContentResponse({ llm }, state, job, materials, async () => {}, { signal: controller.signal })).rejects.toHaveProperty(
    'name',
    'AbortError'
  );
  expect(llm).not.toHaveBeenCalled();
  state.attempts = 3;
  await expect(architectureContentResponse({ llm }, state, job, materials, async () => {})).rejects.toHaveProperty('code', 'ARCHITECTURE_WORKFLOW');
  expect(llm).not.toHaveBeenCalled();
});
it('真实工具执行器允许第三次相同jobPath续接，但仍由工作流限3次；普通重复调用仍被拦', async () => {
  await ws.write('原文.md', '原文内容');
  const llm = vi.fn(async () => 'bad');
  const tool = createArchitectureWorkflowTool({ llm });
  await expect(tool.run({ files: ['原文.md'], request: '制作图', directory: '交付' })).rejects.toBeTruthy();
  const jobPath = (await ws.list('文档检查/架构任务')).find((f) => f.path.endsWith('.json')).path;
  const context = {
    loader: { get: () => tool },
    emit: vi.fn(),
    seen: new Map(),
    review: createExecutionReview('制作架构图'),
    webTools: new Set(),
    parallelSafe: new Set(),
    retrieval: { extensive: true, consume: vi.fn() }
  };
  const call = { id: 'repeat', name: 'build_architecture', args: { jobPath } };
  const results = [];
  for (let i = 0; i < 3; i++) results.push((await executeToolCalls([call], context))[0]);
  expect(llm).toHaveBeenCalledTimes(3);
  expect(results[2].output).toContain('已达3次');
  expect(results[2].output).not.toContain('同样的参数');
  const fourth=(await executeToolCalls([call],context))[0];expect(fourth.output).toContain('已达3次');
  const fifth=(await executeToolCalls([call],context))[0];expect(fifth.output).toContain('同样的参数');expect(llm).toHaveBeenCalledTimes(3);
  await expect(tool.run({jobPath:'文档检查/架构任务/missing.json'})).rejects.toMatchObject({code:'ARCHITECTURE_WORKFLOW',diagnostics:[{stage:'source',field:'jobPath'}]});
  const stateless = { name: 'plain_tool', input_schema: { properties: {} }, run: vi.fn(async () => 'ok') };
  const normal = { ...context, loader: { get: () => stateless }, seen: new Map() };
  for (let i = 0; i < 3; i++) await executeToolCalls([{ id: 'x', name: 'plain_tool', args: {} }], normal);
  expect(stateless.run).toHaveBeenCalledTimes(2);
});
