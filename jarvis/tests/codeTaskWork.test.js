import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codeTaskPolicy, CODE_TASK_MS } from '../server/codeTaskPolicy.mjs';
import { CODE_DEVELOPMENT_BODY, codeWorkBlock } from '../src/agent/codeDevelopment.js';
import { routeFor } from '../src/llm/router.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as packs from '../src/agent/skillPacks.js';
import * as sessions from '../src/agent/sessions.js';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { runAgent } from '../src/agent/agent.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

let folder;
const runners = [];
const until = async (check) => {
  for (let n = 0; n < 400 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};
beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'code-work-'));
  useBackend(createFileStore(folder));
});
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.settled();
  useBackend(null);
  await fs.rm(folder, { recursive: true, force: true });
});

describe('代码开发工作方式', () => {
  it('服务器未连接仓库时不加载代码工作块，也不读取工作副本索引', async () => {
    await packs.seedBuiltins();
    const inputs = [];
    const runner = createTaskRunner({
      codeRepos: {
        connected: async () => false,
        workspaces: async () => {
          throw new Error('不应读取未连接索引');
        }
      },
      getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false }),
      makeTools: () => [],
      makeAdapter: () => ({
        model: 'fixture-default',
        adapter: {
          kind: 'mock',
          stream: async (input) => {
            inputs.push(JSON.stringify(input));
            return { text: '请先连接仓库。', toolCalls: [], stop: 'end_turn' };
          }
        }
      })
    });
    runners.push(runner);
    const task = await runner.start({ text: '检查仓库代码' });
    await until(() => ['done', 'error'].includes(runner.get(task.id).status));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toContain('## 当前代码任务');
    expect((await sessions.get(task.sessionId)).taskCheckpoint.codeTaskId).toBeUndefined();
  });
  it('80步硬上限仅用于动手的仓库任务，图片/普通问答/未连接不扩预算', () => {
    expect(codeTaskPolicy({ text: '修复GitHub仓库的失败测试', hasRepos: true })).toMatchObject({
      enabled: true,
      kind: 'code',
      maxSteps: 80,
      maxTotalSteps: 80
    });
    for (const text of ['你好', '一公斤多少克', 'API是什么', 'GitHub是哪家公司的']) {
      expect(codeTaskPolicy({ text, hasRepos: true, maxSteps: 28 })).toMatchObject({ enabled: false, maxSteps: 28 });
      expect(codeTaskPolicy({ text, hasRepos: true }).maxTotalSteps).toBeUndefined();
    }
    expect(codeTaskPolicy({ text: '修复代码', images: 1, hasRepos: true }).kind).toBe('vision');
    expect(codeTaskPolicy({ text: '修复代码', hasRepos: false }).enabled).toBe(false);
    expect(codeTaskPolicy({ text: '继续', resume: { codeTaskId: 't_old' }, hasRepos: true }).kind).toBe('code');
    expect(codeTaskPolicy({ text: '继续', resume: { taskId: 't_old' }, hasRepos: true }).enabled).toBe(false);
    expect(codeTaskPolicy({ text: '继续', resume: { taskId: 'p2_old', text: '修复仓库代码' }, hasRepos: true }).enabled).toBe(true);
    expect(codeTaskPolicy({ text: '继续', images: 1, resume: { codeTaskId: 't_old' }, hasRepos: true })).toMatchObject({
      enabled: true,
      kind: 'vision',
      maxTotalSteps: 80
    });
    expect(CODE_TASK_MS).toBe(15 * 60_000);
  });

  it('沿用手选代码模型和固定模型，不按内置名字替换', () => {
    const cfg = { provider: 'openai', models: { openai: 'my-default' }, routing: { enabled: true, provider: 'openai', routes: { code: 'my-coder' } } };
    expect(routeFor(cfg, 'code').model).toBe('my-coder');
    expect(routeFor({ ...cfg, pinModel: true }, 'code').model).toBe('my-default');
  });

  it('内置技能可用、禁用/卸载后不被自动工作模式重新启用', async () => {
    await packs.seedBuiltins();
    const installed = await packs.get('code-development');
    expect(installed.enabled).toBe(true);
    expect(codeWorkBlock({ enabled: true }, installed)).toContain(CODE_DEVELOPMENT_BODY);
    expect(codeWorkBlock({ enabled: false }, installed)).toBe('');
    await packs.setEnabled('code-development', false);
    await packs.seedBuiltins();
    expect(codeWorkBlock({ enabled: true }, await packs.get('code-development'))).not.toContain(CODE_DEVELOPMENT_BODY);
    await packs.remove('code-development');
    await packs.seedBuiltins();
    expect(await packs.get('code-development')).toBeFalsy();
  });

  it('循环硬步数不会被旧自动扩步绕过', async () => {
    let calls = 0;
    await runAgent({
      adapter: {
        kind: 'mock',
        stream: async () => ({ text: '', toolCalls: [{ id: String(calls++), name: 'repo_status', args: { n: calls } }], stop: 'tool_use' })
      },
      model: 'any',
      history: [],
      userText: '修复仓库代码',
      maxSteps: 2,
      maxTotalSteps: 3,
      context: { dynamic: '' },
      emit() {},
      quiet: true,
      tools: [{ name: 'repo_status', input_schema: { type: 'object' }, run: async () => 'ok' }]
    });
    expect(calls).toBe(3);
  });

  it('旧步骤摘要清空后仍从索引找回副本，连续恢复沿用原任务ID', async () => {
    const workId = 'a'.repeat(24),
      scopes = [],
      inputs = [];
    let total = 0;
    const repos = {
      writable: true,
      workspaces: async (id) => {
        expect(id).toBe('resume_session');
        return { items: [{ workspace_id: workId, repository: 'demo/sandbox', branch: 'weiyang/task-' + workId }] };
      },
      clone: async (a, scope) => {
        scopes.push(scope);
        return { workspace_id: workId };
      }
    };
    const saved = {
      ...sessions.create({ messages: [{ role: 'user', content: '修复仓库代码', ts: Date.now() }] }),
      id: 'resume_session',
      taskCheckpoint: {
        text: '修复仓库代码',
        taskId: 'original',
        codeTaskId: 'original',
        status: 'interrupted',
        steps: [],
        inFlight: [{ id: 'lost', name: 'code_edit', path: 'src/a.js' }]
      }
    };
    await sessions.save(saved);
    const runner = createTaskRunner({
      codeRepos: repos,
      codeMaxSteps: 1,
      getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false }),
      makeTools: () => [],
      makeAdapter: () => ({
        model: 'chosen-model',
        adapter: {
          kind: 'mock',
          stream: async (input) => {
            inputs.push(JSON.stringify(input));
            return { text: '', toolCalls: [{ id: String(total++), name: 'repo_clone', args: {} }], stop: 'tool_use' };
          }
        }
      })
    });
    runners.push(runner);
    const first = await runner.start({ sessionId: saved.id, text: '继续' });
    await until(() => ['done', 'error'].includes(runner.get(first.id).status));
    const after = await sessions.get(saved.id);
    expect(after.taskCheckpoint.codeTaskId).toBe('original');
    expect(scopes[0]).toEqual({ sessionId: saved.id, taskId: 'original' });
    expect(inputs[0]).toContain(workId);
    expect(inputs[0]).toContain('不得自动重放');
    // 模拟再次中断，恢复不能把第二轮的新taskId当成最初副本。
    after.taskCheckpoint.status = 'interrupted';
    after.taskCheckpoint.steps = [];
    await sessions.save(after);
    const second = await runner.start({ sessionId: saved.id, text: '接着做' });
    await until(() => ['done', 'error'].includes(runner.get(second.id).status));
    expect(scopes[1]).toEqual(scopes[0]);
  });

  it('总代码期限会中止模型并保留可继续的检查点，超时不是用户取消', async () => {
    const runner = createTaskRunner({
      codeRepos: {},
      codeTaskMs: 80,
      makeTools: () => [],
      getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false }),
      makeAdapter: () => ({
        model: 'm',
        adapter: {
          kind: 'mock',
          stream: ({ signal }) =>
            new Promise((resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            })
        }
      })
    });
    runners.push(runner);
    const task = await runner.start({ text: '修复仓库代码' });
    await until(() => ['done', 'error', 'stopped'].includes(runner.get(task.id).status));
    expect(runner.get(task.id)).toMatchObject({ status: 'error', errorKind: 'timeout' });
    expect((await sessions.get(task.sessionId)).taskCheckpoint.codeTaskId).toBe(task.id);
  });
});
