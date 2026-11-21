/** 2026-11-18 用户：电脑老是掉线——点“立即更新服务器”会马上重启，正在做的任务全断；服务器要告诉更新脚本还有几个任务在做 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { useBackend } from '../src/agent/store.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

let dir, runner;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-busy-')); useBackend(createFileStore(dir)); });
afterEach(async () => { for (const t of runner.list()) runner.stop(t.id); await runner.settled(); useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise(r => setTimeout(r, 20)); } };

it('正在做的任务计入 activeCount，做完归零（不返回任务内容）', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const adapter = { stream: async (o) => { await gate; o.onText?.('好'); return { text: '好', toolCalls: [], stop: 'end_turn' }; } };
  runner = createTaskRunner({ getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }), makeAdapter: () => ({ adapter, model: 'm' }) });
  expect(runner.activeCount()).toBe(0);
  const task = await runner.start({ text: '你好' });
  await until(() => runner.get(task.id).status === 'running');
  expect(runner.activeCount()).toBe(1);
  release();
  await until(() => runner.get(task.id).status === 'done');
  expect(runner.activeCount()).toBe(0);
});

it('服务器每5秒写 tasks-busy 标记：有任务写个数，没有就删掉；更新脚本据此等待', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../server/serverMode.mjs'), 'utf8');
  const sh = fs.readFileSync(path.join(import.meta.dirname, '../deploy/update.sh'), 'utf8');
  expect(src).toContain("path.join(dataDir, 'tasks-busy')");
  expect(src).toMatch(/setInterval\(markBusy, 5000\)/);
  expect(sh).toContain('$DATA/tasks-busy');
  expect(sh.indexOf('tasks-busy')).toBeLessThan(sh.indexOf('status installing'));
});
