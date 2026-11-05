/** 智能体广场第1步（服务器）：任务带智能体编号时，服务器按本人注册表解析、对话绑定一个智能体、工具收窄；找不到就报错 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

let dir, runners = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-turn-')); useBackend(createFileStore(dir)); });
afterEach(async () => {
  for (const r of runners) for (const t of r.list()) r.stop(t.id);
  await Promise.all(runners.map(r => r.settled()));
  runners = []; useBackend(null); fs.rmSync(dir, { recursive: true, force: true });
});
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise(r => setTimeout(r, 20)); } };
const mockCfg = async () => ({ ...DEFAULT_CONFIG, provider: 'mock' });
function recording() {
  const calls = [];
  const adapter = { stream: async (o) => { calls.push(o); o.onText?.('好的'); return { text: '好的', toolCalls: [], stop: 'end_turn' }; } };
  return { adapter, calls };
}
const make = (adapter) => { const r = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) }); runners.push(r); return r; };

it('带编号：对话记住智能体与选择；模型看到角色说明和选择，工具只剩该智能体范围内的', async () => {
  const { adapter, calls } = recording();
  const runner = make(adapter);
  const task = await runner.start({ text: '做一份园区汇报PPT', agentId: 'ppt-maker', agentForm: { pages: '6-10', scene: '政企汇报', evil: 'x'.repeat(10) } });
  await until(() => ['done', 'error'].includes(runner.get(task.id).status));
  expect(runner.get(task.id).status).toBe('done');
  const s = await sessions.get(task.sessionId);
  expect(s.agentId).toBe('ppt-maker');
  expect(s.agentForm).toMatchObject({ pages: '6-10', scene: '政企汇报' });
  const system = JSON.stringify(calls[0].system);
  expect(system).toContain('当前智能体：PPT 制作');
  expect(system).toContain('页数 6-10');
  expect(system).not.toContain('evil');
  expect(calls[0].tools.map(t => t.name)).not.toContain('computer_click');
  expect(calls[0].tools.map(t => t.name).some(n => /^(?:run_python|run_javascript|schedule_task)$/.test(n))).toBe(false);
});

it('同一段对话不能中途换成别的智能体', async () => {
  const { adapter } = recording();
  const runner = make(adapter);
  const first = await runner.start({ text: '查一下今天金价', agentId: 'market-quotes' });
  await until(() => ['done', 'error'].includes(runner.get(first.id).status));
  await expect(runner.start({ sessionId: first.sessionId, text: '再做个PPT', agentId: 'ppt-maker' })).rejects.toMatchObject({ status: 409 });
});

it('智能体不存在：任务报错说明原因，不悄悄当普通对话；编号格式不对直接拒绝', async () => {
  const { adapter, calls } = recording();
  const runner = make(adapter);
  const task = await runner.start({ text: '你好', agentId: 'no-such-agent' });
  await until(() => ['done', 'error'].includes(runner.get(task.id).status));
  expect(runner.get(task.id).status).toBe('error');
  expect(runner.get(task.id).error).toContain('智能体不存在');
  expect(calls).toHaveLength(0);
  await expect(runner.start({ text: '你好', agentId: '../../etc' })).rejects.toMatchObject({ name: 'ValidationError' });
});

it('不带编号：和原来一样，对话上没有智能体字段', async () => {
  const { adapter, calls } = recording();
  const runner = make(adapter);
  const task = await runner.start({ text: '你好呀' });
  await until(() => ['done', 'error'].includes(runner.get(task.id).status));
  expect(runner.get(task.id).status).toBe('done');
  expect((await sessions.get(task.sessionId)).agentId).toBeUndefined();
  expect(JSON.stringify(calls[0].system)).not.toContain('当前智能体');
});
