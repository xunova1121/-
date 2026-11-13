import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWorkflow } from '../src/agent/workflowRun.js';
import { validateProfile } from '../src/agent/agentProfileValidation.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { collection, useBackend } from '../src/agent/store.js';
import { createUserStore, runAsUser } from '../server/userScope.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-studio-'));
  useBackend(createUserStore(dir));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
const profile = () =>
  validateProfile({
    ...BUILTIN_AGENTS.find((x) => x.id === 'ppt-maker'),
    id: 'review-ppt',
    source: 'user',
    steps: [
      { title: '调研', task: '找资料' },
      { title: '提纲', task: '写页面提纲与版式', review: true },
      { title: '制作', task: '制作PPT' }
    ]
  });
it('提纲确认前不生成，反馈只重做提纲，确认后从制作继续并清理进度', async () => {
  const run = vi.fn(async (o) => ({ text: o.userText, toolCalls: 0 }));
  const opts = { sessionId: 'same', agent: { profile: profile() } };
  const first = await runWorkflow({ ...opts, userText: '农业路演' }, { run });
  expect(first.awaitingReview).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  run.mockClear();
  const revised = await runWorkflow({ ...opts, userText: '第2页改左右分栏' }, { run });
  expect(revised.awaitingReview).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0].userText).toContain('第 2/3 步');
  expect(run.mock.calls[0][0].userText).toContain('第2页改左右分栏');
  run.mockClear();
  const done = await runWorkflow({ ...opts, userText: '确认继续' }, { run });
  expect(done.awaitingReview).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0].userText).toContain('第 3/3 步');
  expect(await collection('kv').get('workflow-progress:same')).toBeUndefined();
});
it('相同会话编号的不同成员不能拿到对方提纲，修改步骤后不续旧进度', async () => {
  const run = vi.fn(async () => ({ text: '私人材料', toolCalls: 0 }));
  const opts = { sessionId: 'same', agent: { profile: profile() } };
  await runAsUser('u_' + 'a'.repeat(24), () => runWorkflow({ ...opts, userText: '甲的提纲' }, { run }));
  run.mockClear();
  await runAsUser('u_' + 'b'.repeat(24), () => runWorkflow({ ...opts, userText: '确认继续' }, { run }));
  expect(run).toHaveBeenCalledTimes(2);
  run.mockClear();
  const changed = profile();
  changed.steps[0].task = '新的资料要求';
  await runAsUser('u_' + 'a'.repeat(24), () => runWorkflow({ ...opts, userText: '确认继续', agent: { profile: changed } }, { run }));
  expect(run).toHaveBeenCalledTimes(2);
});
it('错误review类型拒绝，无法保存时不声称已待确认', async () => {
  const value = profile();
  value.steps[1].review = 'yes';
  expect(() => validateProfile(value)).toThrow();
  useBackend({
    get: async () => null,
    put: async () => {
      throw new Error('磁盘故障');
    }
  });
  const emit = vi.fn();
  await expect(runWorkflow({ sessionId: 's', userText: '提纲', agent: { profile: profile() }, emit }, { run: async () => ({ text: '材料' }) })).rejects.toThrow(
    '磁盘故障'
  );
  expect(emit.mock.calls.some(([e]) => e.delta?.includes('提纲已保存'))).toBe(false);
});

it('等待确认的步骤实际移除生成、写文件和委派工具，不只靠提示词', async () => {
  const p = profile();
  p.tools = [];
  const tools = ['read_file', 'list_files', 'web_search', 'create_document', 'write_file', 'delegate_task', 'tool_search'].map(name => ({ name }));
  const run = vi.fn(async () => ({ text: '提纲结果' }));
  await runWorkflow({ sessionId: 'restricted', userText: '做PPT', tools, agent: { profile: p } }, { run });
  const review = run.mock.calls[1][0];
  expect(review.tools.map(t => t.name)).toEqual(['read_file', 'list_files', 'web_search', 'tool_search']);
  expect(review.agent.profile.tools.length).toBeGreaterThan(0);
  run.mockClear();
  await runWorkflow({ sessionId: 'restricted', userText: '确认继续', tools, agent: { profile: p } }, { run });
  expect(run.mock.calls[0][0].tools).toBe(tools);
});
