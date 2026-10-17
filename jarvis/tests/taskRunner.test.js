import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { createTaskRunner, SERVER_BLOCKED, DRAFT_MARK, DRAFT_MS } from '../server/taskRunner.mjs';
import { INTERRUPTED_MARK } from '../src/core/suggest.js';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-task-')); useBackend(createFileStore(dir)); });
afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 20)); } };
const mockCfg = async () => ({ ...DEFAULT_CONFIG, provider: 'mock' });

/** 假模型：按脚本一步步回复（tool 调用或文字），可以设置每步之前等多久 */
function scripted(steps, { delay = 0 } = {}) {
  let i = 0;
  return { stream: async ({ onText, signal }) => {
    await new Promise((r, j) => { const t = setTimeout(r, delay); signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s.text) onText?.(s.text);
    return { text: s.text ?? '', toolCalls: s.tools ?? [], stop: s.tools?.length ? 'tool_use' : 'end_turn' };
  } };
}

describe('服务器任务执行器', () => {
  it('发任务 → 服务器做完 → 回答存进对话；进度事件按序号可补发', async () => {
    const runner = createTaskRunner({ getConfig: mockCfg });
    const { id, sessionId } = await runner.start({ text: '你好，介绍一下你自己' });
    await until(() => runner.get(id).status === 'done');
    const s = await sessions.get(sessionId);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[1].content.length).toBeGreaterThan(0);
    const all = runner.events(id, 0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.at(-1)).toMatchObject({ type: 'task_state', status: 'done' });
    expect(runner.events(id, all.at(-2).seq)).toHaveLength(1); // 断线重连：只补发漏掉的
  });

  it('真的动手：用工具在服务器上写文件，文件记在任务和回答里', async () => {
    const adapter = scripted([
      { tools: [{ id: 'a', name: 'write_file', args: { path: '报告/说明.md', content: '# 说明\n内容' } }] },
      { text: '已写好 报告/说明.md。' }
    ]);
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) });
    const { id, sessionId } = await runner.start({ text: '写一份说明' });
    await until(() => runner.get(id).status === 'done');
    expect(runner.get(id).files).toEqual(['报告/说明.md']);
    const ws = await import('../src/agent/workspace.js');
    expect(await ws.readText('报告/说明.md')).toContain('内容');
    const last = (await sessions.get(sessionId)).messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: '已写好 报告/说明.md。', files: ['报告/说明.md'], tools: ['write_file'] });
  });

  it('同一个对话正在干活时又发一句：不另起任务，交给正在干的；用户可以叫停', async () => {
    const adapter = scripted([{ text: '做了一半' }], { delay: 5000 });
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) });
    const a = await runner.start({ text: '做个很长的任务' });
    await until(() => runner.get(a.id).status === 'running');
    const b = await runner.start({ sessionId: a.sessionId, text: '顺便加一页总结' });
    expect(b).toMatchObject({ id: a.id, joined: true });
    expect(runner.stop(a.id)).toBe(true);
    await until(() => runner.get(a.id).status === 'stopped');
    const s = await sessions.get(a.sessionId);
    expect(s.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['做个很长的任务', '顺便加一页总结']);
  });

  it('同时只做 maxRunning 个，其余排队；排队中的也能取消', async () => {
    const adapter = scripted([{ text: '好' }], { delay: 300 });
    const runner = createTaskRunner({ getConfig: mockCfg, maxRunning: 1, makeAdapter: () => ({ adapter, model: 'm' }) });
    const a = await runner.start({ text: '任务一' });
    const b = await runner.start({ text: '任务二' });
    const c = await runner.start({ text: '任务三' });
    expect(runner.get(b.id).status).toBe('queued');
    runner.stop(c.id);
    await until(() => runner.get(a.id).status === 'done' && runner.get(b.id).status === 'done');
    expect(runner.get(c.id).status).toBe('stopped');
    expect(runner.running).toBe(0);
  });

  it('连续没有进展就中断，记为失败；服务器上不给运行代码、预览这类工具', async () => {
    const adapter = scripted([{ text: '…' }], { delay: 5000 });
    let names = [];
    const runner = createTaskRunner({ getConfig: mockCfg, idleMs: 100, makeAdapter: () => ({ adapter, model: 'm' }), makeTools: (ctx) => { const t = [{ name: 'run_python' }, { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} }, run: async () => '' }]; names = t.map((x) => x.name); return t; } });
    const { id } = await runner.start({ text: '卡住的任务' });
    await until(() => runner.get(id).status === 'error');
    expect(runner.get(id).error).toMatch(/没有进展/);
    expect(names).toContain('run_python');
    expect(SERVER_BLOCKED.has('run_python')).toBe(true);
  });
});

describe('服务器中途重启：写了一半的回答不丢', () => {
  it('做的过程中先存半截回答；做完换成完整的', async () => {
    DRAFT_MS.value = 30;
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      let n = 0;
      const adapter = { stream: async ({ onText }) => { if (n++ === 0) { onText('写了一半，'); await gate; return { text: '写了一半，', toolCalls: [], stop: 'end_turn' }; } return { text: '', toolCalls: [], stop: 'end_turn' }; } };
      const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter, model: 'm' }) });
      const { id, sessionId } = await runner.start({ text: '写个东西' });
      await until(async () => (await sessions.get(sessionId)).messages.some((m) => m.draftOf === id));
      const mid = (await sessions.get(sessionId)).messages.at(-1);
      expect(mid.content).toContain('写了一半');
      expect(mid.content).toContain(DRAFT_MARK);
      release();
      await until(() => runner.get(id).status === 'done');
      const msgs = (await sessions.get(sessionId)).messages;
      expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1);
      expect(msgs.some((m) => m.draftOf)).toBe(false);
    } finally { DRAFT_MS.value = 10_000; }
  });
  it('重启后：上次没做完的半截回答标成“没完成”', async () => {
    const s = { ...sessions.create(), id: 'cdraft1', messages: [{ role: 'user', content: '写个东西', ts: 1 }, { role: 'assistant', content: `写了一半\n\n${DRAFT_MARK}`, ts: 2, draftOf: 'tgone' }] };
    await sessions.save(s);
    const runner = createTaskRunner({ getConfig: mockCfg });
    await runner.start({ text: '你好' }).catch(() => {}); // start 会等恢复做完
    const got = (await sessions.get('cdraft1')).messages.at(-1);
    expect(got.draftOf).toBeUndefined();
    expect(got.content).toContain(INTERRUPTED_MARK);
    expect(got.content).not.toContain(DRAFT_MARK);
  });
});

describe('服务器上画图', () => {
  it('generate_image 工具接上了服务器的模型设置（不再报“当前环境不能画图”）', async () => {
    let ctxSeen;
    const runner = createTaskRunner({ getConfig: mockCfg, makeAdapter: () => ({ adapter: scripted([{ text: '好' }]), model: 'm' }), makeTools: (ctx) => { ctxSeen = ctx; return []; } });
    const { id } = await runner.start({ text: '画一只猫' });
    await until(() => runner.get(id).status === 'done');
    expect(typeof ctxSeen.imageGen).toBe('function');
    expect(typeof ctxSeen.videoGen).toBe('function');
  });
});
