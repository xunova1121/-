import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { normalizePlan, createPlanTool, unfinished } from '../src/agent/plan.js';
import { compactToolResults } from '../src/agent/turnContext.js';
import { matchFiles, searchLines, globToRegex } from '../src/agent/fileSearch.js';
import { finishCheck, PARALLEL_SAFE } from '../src/agent/agent.js';

const call = (id, name, args = {}) => ({ id, name, args });
const ctx = { dynamic: '测试', kbHits: [] };

describe('任务清单 update_plan', () => {
  it('整理步骤：去空、统一状态、最多 12 步', () => {
    expect(normalizePlan([{ text: '查资料', status: 'in_progress' }, '写报告', { text: '' }, { text: '发给用户', status: 'completed' }]))
      .toEqual([{ text: '查资料', status: 'doing' }, { text: '写报告', status: 'todo' }, { text: '发给用户', status: 'done' }]);
    expect(normalizePlan(Array.from({ length: 20 }, (_, i) => `第${i}步`))).toHaveLength(12);
  });
  it('每次更新都通知界面，并告诉模型接下来做哪一步', async () => {
    const seen = [];
    const p = createPlanTool((s) => seen.push(s));
    const out = await p.tool.run({ steps: [{ text: '查天气', status: 'done' }, { text: '写建议', status: 'todo' }] });
    expect(out).toMatch(/完成 1\/2.*接下来：写建议/);
    expect(seen).toHaveLength(1);
    expect(unfinished(p.steps).map((s) => s.text)).toEqual(['写建议']);
    await expect(p.tool.run({ steps: [] })).rejects.toThrow(/清单是空的/);
  });
});

describe('收尾核对', () => {
  it('清单没勾完、写了代码没运行：给出提醒；都没问题：不提醒', () => {
    expect(finishCheck({ steps: [{ text: '写报告', status: 'todo' }] })).toMatch(/还有 1 步没标完成：“写报告”/);
    expect(finishCheck({ wroteCode: true })).toMatch(/还没有运行或预览过/);
    expect(finishCheck({ wroteCode: true, ranCode: true, steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'skip' }] })).toBe('');
  });

  it('模型想结束但清单没勾完：提醒一次，它把剩下的做完再结束', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const { runAgent } = await import('../src/agent/agent.js');
    let n = 0;
    const prompts = [];
    const adapter = { async stream({ messages, onText }) {
      n++;
      prompts.push(messages.at(-1));
      if (n === 1) return { text: '', toolCalls: [call('1', 'update_plan', { steps: [{ text: '查资料', status: 'done' }, { text: '写结论', status: 'todo' }] })], stop: 'tool_use' };
      if (n === 2) { onText('先这样。'); return { text: '先这样。', toolCalls: [], stop: 'end_turn' }; }
      if (n === 3) return { text: '', toolCalls: [call('2', 'update_plan', { steps: [{ text: '查资料', status: 'done' }, { text: '写结论', status: 'done' }] })], stop: 'tool_use' };
      onText('结论：可以。'); return { text: '结论：可以。', toolCalls: [], stop: 'end_turn' };
    } };
    const events = [];
    const r = await runAgent({ adapter, model: 'x', history: [], userText: '帮我查一下再写结论', tools: [], context: ctx, emit: (e) => events.push(e) });
    expect(prompts[2].content).toMatch(/还有 1 步没标完成：“写结论”/);
    expect(r.text).toMatch(/先这样。[\s\S]*结论：可以。/);
    expect(events.filter((e) => e.type === 'plan').at(-1).steps.every((s) => s.status === 'done')).toBe(true);
    expect(n).toBe(4);
    delete globalThis.indexedDB;
  });

  it('非代码任务只提醒一次，模型坚持不改就正常结束（不反复核实）', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const { runAgent } = await import('../src/agent/agent.js');
    let n = 0;
    const adapter = { async stream() {
      n++;
      if (n === 1) return { text: '', toolCalls: [call('1', 'update_plan', { steps: [{ text: '写结论', status: 'todo' }] })], stop: 'tool_use' };
      return { text: '做不了', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'x', history: [], userText: 'x', tools: [], context: ctx, emit: () => {} });
    expect(n).toBe(3); // 第一次结束 + 一次提醒
    delete globalThis.indexedDB;
  });

  it('写了代码的任务最多提醒两次', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const { runAgent } = await import('../src/agent/agent.js');
    let n = 0;
    const adapter = { async stream() {
      n++;
      if (n === 1) return { text: '', toolCalls: [call('1', 'update_plan', { steps: [{ text: '写结论', status: 'todo' }] })], stop: 'tool_use' };
      return { text: '做不了', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'x', history: [], userText: '写一个 Python 脚本', tools: [], context: ctx, emit: () => {} });
    expect(n).toBe(4); // 第一次结束 + 两次提醒
    delete globalThis.indexedDB;
  });
});

describe('一轮任务中途的上下文瘦身', () => {
  it('工具结果超过预算：较早的缩短，最近几条原样；较早的截图只留两张', () => {
    const big = 'x'.repeat(20000);
    const convo = [{ role: 'user', content: '开始' }, ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool', name: 't', content: `${i}${big}`, ...(i < 4 && { images: [{ mime: 'image/png', data: 'a' }] }) }))];
    const r = compactToolResults(convo, { budget: 60000, keep: 3 });
    const tools = convo.filter((m) => m.role === 'tool');
    expect(r.saved).toBeGreaterThan(80000);
    expect(tools[0].content).toMatch(/较早的工具结果，为节省上下文已缩短，原文共 20001 字/);
    expect(tools.at(-1).content.length).toBe(20001);
    expect(tools.filter((m) => m.images).length).toBe(2);
    expect(convo[0].content).toBe('开始');
  });
  it('没超预算：一个字都不动', () => {
    const convo = [{ role: 'tool', content: 'y'.repeat(5000) }];
    compactToolResults(convo);
    expect(convo[0].content.length).toBe(5000);
  });
});

describe('同时执行只读工具', () => {
  it('同一步里的几个搜索同时做，结果按调用顺序写回', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const { runAgent } = await import('../src/agent/agent.js');
    let running = 0, peak = 0;
    const slow = { name: 'web_search', description: '测试', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async ({ query }) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running--; return `结果 ${query}`; } };
    let n = 0;
    let order = [];
    const adapter = { async stream({ messages }) {
      n++;
      if (n === 1) return { text: '', toolCalls: [call('a', 'web_search', { query: '一' }), call('b', 'web_search', { query: '二' }), call('c', 'web_search', { query: '三' })], stop: 'tool_use' };
      order = messages.filter((m) => m.role === 'tool').map((m) => m.content);
      return { text: '好', toolCalls: [], stop: 'end_turn' };
    } };
    await runAgent({ adapter, model: 'x', history: [], userText: 'x', tools: [slow], context: ctx, emit: () => {} });
    expect(peak).toBe(3);
    expect(order).toEqual(['结果 一', '结果 二', '结果 三']);
    expect(PARALLEL_SAFE.has('write_file')).toBe(false);
    delete globalThis.indexedDB;
  });
});

describe('子任务分身 delegate_task', () => {
  it('分身在独立上下文里查资料，只把结论带回主线；分身不能再派分身、不能写文件', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const { runAgent } = await import('../src/agent/agent.js');
    const search = { name: 'web_search', description: '测试', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => '很长的原始资料'.repeat(50) };
    const write = { name: 'write_file', description: '测试', input_schema: { type: 'object', properties: {} }, run: async () => 'ok' };
    const subTools = [];
    const adapter = { async stream({ messages, tools, onText }) {
      const first = messages[0].content;
      if (first === '调研南京周末天气') { // 分身
        subTools.push(tools.map((t) => t.name));
        if (!messages.some((m) => m.role === 'tool')) return { text: '', toolCalls: [call('s1', 'web_search', { query: '南京 周末 天气' })], stop: 'tool_use' };
        onText('结论：周末晴，18–25℃。'); return { text: '结论：周末晴，18–25℃。', toolCalls: [], stop: 'end_turn' };
      }
      if (!messages.some((m) => m.role === 'tool')) return { text: '', toolCalls: [call('d1', 'delegate_task', { task: '调研南京周末天气' })], stop: 'tool_use' };
      const back = messages.find((m) => m.role === 'tool').content;
      onText(`收到：${back}`); return { text: `收到：${back}`, toolCalls: [], stop: 'end_turn' };
    } };
    const progress = [];
    const r = await runAgent({ adapter, model: 'x', history: [], userText: '周末适合出去玩吗', tools: [search, write], context: ctx, emit: (e) => { if (e.type === 'tool_progress') progress.push(e.text); } });
    expect(r.text).toBe('收到：结论：周末晴，18–25℃。');
    expect(r.text).not.toContain('很长的原始资料');
    expect(subTools[0]).toContain('web_search');
    expect(subTools[0]).not.toContain('delegate_task');
    expect(subTools[0]).not.toContain('write_file');
    expect(progress.some((t) => /分身：web_search/.test(t))).toBe(true);
    delete globalThis.indexedDB;
  });
});

describe('工作区找文件、搜内容', () => {
  const files = [{ path: 'site/index.html' }, { path: 'site/js/app.js' }, { path: '周报/第三周周报.docx' }, { path: 'data.xlsx' }];
  it('通配符和关键词找文件', () => {
    expect(matchFiles(files, '*.docx').map((f) => f.path)).toEqual(['周报/第三周周报.docx']);
    expect(matchFiles(files, 'site/**/*.js').map((f) => f.path)).toEqual(['site/js/app.js']);
    expect(matchFiles(files, '周报').map((f) => f.path)).toEqual(['周报/第三周周报.docx']);
    expect(globToRegex('a/*.js').test('a/b/c.js')).toBe(false);
  });
  it('逐行搜内容，给行号；正则写错时说清楚', () => {
    expect(searchLines('第一行\n标题：未央\n结尾', '未央')).toEqual([{ line: 2, text: '标题：未央' }]);
    expect(searchLines('a1\nb22', 'b\\d+', { regex: true })[0].line).toBe(2);
    expect(() => searchLines('x', '(', { regex: true })).toThrow(/正则写错了/);
  });
});

describe('工具：找文件、搜内容、先读后改', () => {
  let tools, ws;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
    tools = (await import('../src/agent/tools.js')).createTools({});
  });
  afterEach(() => { delete globalThis.indexedDB; });
  const run = (name, args) => tools.find((t) => t.name === name).run(args, {});

  it('find_files / search_in_files 在工作区里定位', async () => {
    await ws.write('site/index.html', '<h1>未央</h1>\n<p>你好</p>');
    await ws.write('notes.md', '# 笔记\n未央的设计');
    expect(await run('find_files', { pattern: '*.html' })).toMatch(/site\/index\.html/);
    const hits = await run('search_in_files', { query: '未央' });
    expect(hits).toMatch(/site\/index\.html:1: <h1>未央<\/h1>/);
    expect(hits).toMatch(/notes\.md:2: 未央的设计/);
    expect(await run('search_in_files', { query: '不存在的词' })).toMatch(/没有找到/);
  });

  it('覆盖一个没读过的已有文件：先拦一次，读过（或坚持）就放行；自己刚写的可以直接改写', async () => {
    await ws.write('a.md', '原来的内容');
    await expect(run('write_file', { path: 'a.md', content: '新' })).rejects.toThrow(/已经存在，你还没读过它/);
    expect(await run('write_file', { path: 'a.md', content: '新' })).toMatch(/已写入/); // 坚持再写一次
    await ws.write('b.md', '原来');
    await run('read_file', { path: 'b.md' });
    expect(await run('write_file', { path: 'b.md', content: '新' })).toMatch(/已写入/);
    expect(await run('write_file', { path: 'c.md', content: '1' })).toMatch(/已写入/);
    expect(await run('write_file', { path: 'c.md', content: '2' })).toMatch(/已写入/);
  });

  it('edit_file 找不到原文、又没读过文件：提示先读', async () => {
    await ws.write('d.md', '甲乙丙');
    await expect(run('edit_file', { path: 'd.md', edits: [{ old_text: '丁', new_text: '戊' }] })).rejects.toThrow(/先用 read_file 看准原文再改/);
  });
});

describe('工作准则', () => {
  it('写进了：先弄清要什么、列清单、先读后改、能并行就并行、边做边验证、做完对照、如实汇报、风险先确认、交给分身', async () => {
    const { STABLE_PROMPT } = await import('../src/agent/agent.js');
    for (const k of ['先弄清要什么', 'update_plan', 'find_files', 'search_in_files', '能一起做的一起做', '边做边验证', '做完先对照', '如实汇报', '有风险先确认', 'delegate_task']) expect(STABLE_PROMPT).toContain(k);
  });
});
