import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createEvaluationAccess } from '../server/evaluationAccess.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

it('任务注入的自定义搜索在未知域名请求前同时计模型/搜索额度；额度不足及取消绝不出站', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-search-eval-'));
  const store = createFileStore(directory);
  useBackend(store);
  let supplied;
  const adapter = { kind: 'mock', async stream({ onText }) {
    onText?.('你好'); return { text: '你好', toolCalls: [], stop: 'end_turn' };
  } };
  const runner = createTaskRunner({
    getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false }),
    makeAdapter: () => ({ adapter, model: 'fixture-model' }),
    makeTools: context => { supplied = context; return []; }
  });
  try {
    await runner.start({ text: '你好' });
    await runner.settled();
    expect(typeof supplied.openaiSearchFetch).toBe('function');
    const quota = Object.assign(new Error('fixture quota'), { code: 'EVAL_QUOTA' });
    const consume = vi.fn((_id, kind) => { if (kind === 'search') throw quota; });
    const access = createEvaluationAccess({ store, dataDir: directory, security: { consume } });
    const task = { evaluationAuthorization: { id: 'fixture-eval' }, evaluationId: 'fixture-private-scope' };
    const network = vi.fn(() => { throw new Error('额度不足仍请求了网络'); });
    vi.stubGlobal('fetch', network);
    expect(() => access.run(task, () => supplied.openaiSearchFetch('https://unknown-search.example/v1/responses', { method: 'POST' }))).toThrow(quota);
    expect(consume.mock.calls).toEqual([['fixture-eval', 'model'], ['fixture-eval', 'search']]);
    expect(network).not.toHaveBeenCalled();
    consume.mockClear();
    consume.mockImplementation(() => { throw quota; });
    expect(() => access.run(task, () => supplied.openaiSearchFetch('https://unknown-search.example/v1/responses', { method: 'POST' }))).toThrow(quota);
    expect(consume.mock.calls).toEqual([['fixture-eval', 'model']]);
    const controller = new AbortController(); controller.abort();
    consume.mockClear();
    expect(() => access.run(task, () => supplied.openaiSearchFetch('https://unknown-search.example/v1/responses', { signal: controller.signal }))).toThrow();
    expect(consume).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    for (const task of runner.list()) runner.stop(task.id);
    await runner.settled();
    useBackend(null);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
