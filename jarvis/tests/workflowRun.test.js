/** 工作流（编排层）：配置校验、按步骤顺序调用底座、每步用该步智能体、检查不合格重做一次、定时任务带智能体、服务器端真实执行 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { validateProfile, MAX_WORKFLOW_STEPS } from '../src/agent/agentProfileValidation.js';
import { runWorkflow, stepPrompt, STEP_CHECKS } from '../src/agent/workflowRun.js';
import { createAgentRegistry } from '../src/agent/agentProfiles.js';
import * as scheduler from '../src/agent/scheduler.js';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

const base = { id: 'my-gongwen-flow', name: '请示流水线', icon: 'spark', category: 'mine', intro: '起草并体检请示', starters: ['写请示', '改请示', '查请示'], prompt: '', tools: [], form: [], output: 'docx', source: 'user' };
const flow = { ...base, steps: [{ title: '收集要点', task: '整理用户给的要点' }, { title: '起草', task: '起草请示', agentId: 'gongwen-writer', check: 'gongwen' }] };

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-')); useBackend(createFileStore(dir)); });
afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

it('配置校验：步骤可选；检查方式、步数、交给自己都会报错；旧配置照常', () => {
  expect(validateProfile(base).steps).toBeUndefined();
  expect(validateProfile(flow).steps).toEqual([{ title: '收集要点', task: '整理用户给的要点' }, { title: '起草', task: '起草请示', agentId: 'gongwen-writer', check: 'gongwen' }]);
  expect(validateProfile({ ...base, steps: [] }).steps).toBeUndefined();
  expect(() => validateProfile({ ...base, steps: [{ title: 'a', task: 'b', check: 'magic' }] })).toThrow(/steps\[0\]\.check/);
  expect(() => validateProfile({ ...base, steps: Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, () => ({ title: 'a', task: 'b' })) })).toThrow(/steps/);
  expect(() => validateProfile({ ...base, steps: [{ title: 'a', task: 'b', agentId: base.id }] })).toThrow(/工作流自己/);
  expect(() => validateProfile({ ...base, steps: [{ title: '', task: 'b' }] })).toThrow(/steps\[0\]\.title/);
});

it('按顺序执行：每步用自己的智能体，后一步拿到前一步结果；只完成这一步', async () => {
  const calls = [];
  const run = vi.fn(async (o) => { calls.push(o); return { text: calls.length === 1 ? '要点：申请经费5万元' : '关于经费的请示\n\n区文旅局：\n\n申请经费5万元。\n\n妥否，请批示。\n\n2026年11月5日', toolCalls: 1 }; });
  const out = await runWorkflow({ userText: '帮我写个请示', agent: { profile: validateProfile(flow), note: '' }, emit: () => {} }, { run });
  expect(run).toHaveBeenCalledTimes(2);
  expect(calls[0].agent.profile.id).toBe('my-gongwen-flow');
  expect(calls[0].agent.profile.steps).toBeUndefined();
  expect(calls[1].agent.profile.id).toBe('gongwen-writer');
  expect(calls[0].userText).toContain('第 1/2 步：收集要点');
  expect(calls[0].userText).toContain('只完成这一步');
  expect(calls[1].userText).toContain('要点：申请经费5万元');
  expect(out).toMatchObject({ workflow: true, steps: 2, toolCalls: 2 });
  expect(out.text).toContain('第 2 步 · 起草');
});

it('检查不合格：把问题交回去重做一次；合格就不重做', async () => {
  let n = 0;
  const run = vi.fn(async () => ({ text: ++n === 1 ? '关于经费的请示\n\n区文旅局、区财政局：\n\n申请经费。' : '关于经费的请示\n\n区文旅局：\n\n申请经费。\n\n妥否，请批示。\n\n2026年11月5日', toolCalls: 0 }));
  const one = validateProfile({ ...base, steps: [{ title: '起草', task: '起草请示', check: 'gongwen' }] });
  const out = await runWorkflow({ userText: '写请示', agent: { profile: one, note: '' } }, { run });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][0].userText).toMatch(/没有通过检查[\s\S]*主送/);
  expect(out.text).toContain('妥否，请批示');
  expect(STEP_CHECKS.gongwen('关于经费的请示\n\n区文旅局：\n\n妥否，请批示。\n\n2026年11月5日')).toBe('');
});

it('步骤要用的智能体不存在就报错；停止信号立即结束；没有步骤就是普通对话', async () => {
  const missing = validateProfile({ ...base, steps: [{ title: 'a', task: 'b', agentId: 'not-here' }] });
  await expect(runWorkflow({ userText: 'x', agent: { profile: missing } }, { run: async () => ({ text: '' }), lookup: async () => null })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  const ctrl = new AbortController(); ctrl.abort();
  await expect(runWorkflow({ userText: 'x', signal: ctrl.signal, agent: { profile: validateProfile(flow) } }, { run: async () => ({ text: '' }) })).rejects.toMatchObject({ name: 'AbortError' });
  const run = vi.fn(async () => ({ text: '好的' }));
  await runWorkflow({ userText: 'x', agent: { profile: validateProfile(base) } }, { run });
  expect(run).toHaveBeenCalledTimes(1);
  expect(stepPrompt({ workflow: 'w', step: { title: 't', task: 'k' }, index: 0, total: 1, userText: 'u', previous: [] })).toContain('最后一步');
});

it('定时任务记住要用的智能体；编号格式不对的不存', async () => {
  const s = await scheduler.upsert({ title: '周报', prompt: '写周报', kind: 'daily', time: '17:00', agentId: 'my-gongwen-flow' });
  expect(s.agentId).toBe('my-gongwen-flow');
  const bad = await scheduler.upsert({ title: '周报2', prompt: '写周报2', kind: 'daily', time: '18:00', agentId: '../x' });
  expect(bad.agentId).toBeUndefined();
});

it('服务器端：个人工作流按步骤真实执行，每步调用一次模型', async () => {
  await createAgentRegistry().createAgent(flow);
  const prompts = [];
  const adapter = { stream: async (o) => { prompts.push(JSON.stringify(o.messages)); const t = '关于经费的请示\n\n区文旅局：\n\n妥否，请批示。\n\n2026年11月5日'; o.onText?.(t); return { text: t, toolCalls: [], stop: 'end_turn' }; } };
  const runner = createTaskRunner({ getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }), makeAdapter: () => ({ adapter, model: 'm' }) });
  try {
    const task = await runner.start({ text: '帮我写个请示', agentId: 'my-gongwen-flow' });
    const t0 = Date.now();
    while (!['done', 'error'].includes(runner.get(task.id).status)) { if (Date.now() - t0 > 8000) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); }
    expect(runner.get(task.id).status).toBe('done');
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts.some((p) => p.includes('第 1/2 步'))).toBe(true);
    expect(prompts.some((p) => p.includes('第 2/2 步'))).toBe(true);
  } finally {
    for (const t of runner.list()) runner.stop(t.id);
    await runner.settled();
  }
});
