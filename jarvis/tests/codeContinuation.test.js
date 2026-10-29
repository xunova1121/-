import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCodeWork } from '../server/codeWorkContext.mjs';
import { codeTaskPolicy } from '../server/codeTaskPolicy.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

const id = 'a'.repeat(24);
it('明确制作商城属于代码任务，查询网页/问怎么开发与普通对话不扩预算', () => {
  expect(codeTaskPolicy({ text: '帮我做个电商网页', hasRepos: true }).enabled).toBe(true);
  expect(codeTaskPolicy({ text: '继续，结合这张截图检查。', images: 1, hasRepos: true, resume: { codeTaskId: 'original' } })).toMatchObject({ enabled: true, kind: 'vision' });
  for (const text of ['查询这个网页', '怎么开发商城', '继续查刚才天气', '你好', '做一张架构图，附HTML预览', '制作Word报告，生成网页预览']) expect(codeTaskPolicy({ text, hasRepos: true }).enabled).toBe(false);
});

it('只用本会话真实索引恢复，未知/多个副本不允许clone替代，查天气不读索引', async () => {
  const scopes = [];
  const base = { text: '继续商城任务', images: 0, sessionId: 'owner', taskId: 'new', checkpoint: {}, maxSteps: 28, codeMaxSteps: 80 };
  const repos = {
    connected: async () => true,
    workspaces: async (session) => {
      expect(session).toBe('owner');
      return { items: [{ workspace_id: id, task_id: 'original', repository: 'demo/repo' }] };
    },
    clone: async (_, scope) => {
      scopes.push(scope);
      return { workspace_id: id };
    }
  };
  const result = await prepareCodeWork({ ...base, repos });
  expect(result.policy.enabled).toBe(true);
  expect(result.codeTaskId).toBe('original');
  await result.scopedRepos.clone({}, { sessionId: 'owner', taskId: 'new' }, {});
  expect(scopes).toEqual([{ sessionId: 'owner', taskId: 'original' }]);
  for (const items of [
    [],
    [
      { workspace_id: id, task_id: 'a' },
      { workspace_id: 'b'.repeat(24), task_id: 'b' }
    ]
  ]) {
    const r = await prepareCodeWork({ ...base, checkpoint: { codeTaskId: 'original' }, repos: { ...repos, workspaces: async () => ({ items }) } });
    await expect(r.scopedRepos.clone({}, { sessionId: 'owner', taskId: 'new' }, {})).rejects.toMatchObject({ code: 'CODE_WORKTREE' });
  }
  const ordinary = await prepareCodeWork({
    ...base,
    text: '继续查刚才天气',
    repos: {
      ...repos,
      workspaces: async () => {
        throw new Error('普通查询不应读索引');
      }
    }
  });
  expect(ordinary.policy.enabled).toBe(false);
});

it('真实任务执行器：已完成的商城任务继续保留原taskId，不重放旧检查点', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'completed-code-'));
  useBackend(createFileStore(root));
  let runner;
  try {
    const saved = {
      ...sessions.create({
        messages: [
          { role: 'user', content: '帮我做个电商网页', ts: Date.now() },
          { role: 'assistant', content: '文件已写入任务工作副本。', ts: Date.now() }
        ]
      }),
      id: 'completed_code',
      taskCheckpoint: { text: '帮我做个电商网页', taskId: 'original', status: 'done', steps: [], inFlight: [] }
    };
    await sessions.save(saved);
    const scopes = [],
      inputs = [];
    runner = createTaskRunner({
      codeMaxSteps: 1,
      codeRepos: {
        writable: true,
        connected: async () => true,
        workspaces: async () => ({ items: [{ workspace_id: id, task_id: 'original', repository: 'demo/repo' }] }),
        clone: async (_, scope) => {
          scopes.push(scope);
          return { workspace_id: id };
        }
      },
      getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false }),
      makeTools: () => [],
      makeAdapter: () => ({
        model: 'fixture',
        adapter: {
          kind: 'mock',
          stream: async (input) => {
            inputs.push(JSON.stringify(input));
            return { text: '', toolCalls: [{ id: 'clone', name: 'repo_clone', args: {} }], stop: 'tool_use' };
          }
        }
      })
    });
    const task = await runner.start({ sessionId: saved.id, text: '继续' });
    for (let n = 0; n < 400 && !['done', 'error'].includes(runner.get(task.id).status); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.get(task.id).status).toBe('done');
    expect(scopes[0]).toEqual({ sessionId: saved.id, taskId: 'original' });
    expect(inputs[0]).toContain(id);
    expect(inputs[0]).not.toContain('恢复上次');
    expect((await sessions.get(saved.id)).taskCheckpoint.codeTaskId).toBe('original');
  } finally {
    await runner?.settled();
    useBackend(null);
    await fs.rm(root, { recursive: true, force: true });
  }
});
