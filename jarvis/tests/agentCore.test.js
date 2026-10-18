/** 智能体底层第二批：模型出错自动换备用模型、项目规则文件、长任务中途提醒 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { fallbackRoutes, canFallback } from '../src/llm/router.js';
import { loadRules, rulesBlock, RULES_MAX } from '../src/agent/projectRules.js';

const call = (id, name, args = {}) => ({ id, name, args });
const ctx = { dynamic: '测试', kbHits: [] };
const done = (text) => ({ async stream({ onText }) { onText(text); return { text, toolCalls: [], stop: 'end_turn' }; } });

let agent;
beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  agent = await import('../src/agent/agent.js');
});
afterEach(() => { delete globalThis.indexedDB; });

describe('模型出错自动换备用模型', () => {
  it('哪些错误换模型：临时故障、限流、模型不存在、余额不足换；点停止、参数错误不换', () => {
    for (const e of [{ status: 503 }, { status: 524 }, { status: 429 }, { status: 404 }, { status: 402 }, { name: 'TypeError', message: 'Failed to fetch' }, { message: '无可用渠道' }, { message: 'The model `x` does not exist or is not available' }]) {
      expect(canFallback(Object.assign(new Error(e.message ?? ''), e)), JSON.stringify(e)).toBe(true);
    }
    expect(canFallback(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(canFallback(Object.assign(new Error('模型接口返回 400：参数不对'), { status: 400 }))).toBe(false);
    expect(canFallback(null)).toBe(false);
  });

  it('备用模型：分工里设过的其他模型、默认模型、其他填了密钥的服务商；不重复、不含当前、最多 2 个', () => {
    const cfg = {
      provider: 'relay-multi', models: { 'relay-multi': 'claude-haiku-5-5', deepseek: 'deepseek-chat' }, keys: { 'relay-multi': 'k', deepseek: 'k2' },
      routing: { enabled: true, provider: 'relay-multi', routes: { chat: 'relay-multi::claude-haiku-5-5', reason: 'relay-multi::gpt-6.1-sol', code: 'gpt-6.1-sol' } }
    };
    const r = fallbackRoutes(cfg, { provider: 'relay-multi', model: 'claude-haiku-5-5' });
    expect(r.map((x) => `${x.provider}/${x.model}`)).toEqual(['relay-multi/gpt-6.1-sol', 'deepseek/deepseek-chat']);
    expect(r[1].cfg.provider).toBe('deepseek');
    // 没开分工、只有一家：当前就是默认模型，没有备用
    expect(fallbackRoutes({ provider: 'relay-multi', models: { 'relay-multi': 'm' }, keys: { 'relay-multi': 'k' } }, { provider: 'relay-multi', model: 'm' })).toEqual([]);
  });

  it('重试后还是出错、这一步还没输出：换备用模型接着做，通知界面，后面的步骤都用新模型', async () => {
    const broken = { async stream() { throw Object.assign(new Error('模型接口返回 503'), { status: 503 }); } };
    const events = [];
    const models = [];
    let n = 0;
    const backup = { async stream({ model, onText }) {
      models.push(model);
      if (++n === 1) return { text: '', toolCalls: [call('1', 'update_plan', { steps: [{ text: '回答', status: 'done' }] })], stop: 'tool_use' };
      onText('换了模型也答出来了'); return { text: '换了模型也答出来了', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await agent.runAgent({ adapter: broken, model: 'claude-haiku-5-5', fallbacks: [{ adapter: backup, model: 'gpt-6.1-sol' }], history: [], userText: '你好', tools: [], context: ctx, emit: (e) => events.push(e) });
    expect(r.text).toBe('换了模型也答出来了');
    expect(events.find((e) => e.type === 'fallback')).toEqual({ type: 'fallback', from: 'claude-haiku-5-5', to: 'gpt-6.1-sol', reason: '模型接口返回 503' });
    expect(models).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
  });

  it('已经输出了一半、点了停止、或者参数错误：不换，照常报错', async () => {
    const half = { async stream({ onText }) { onText('写到一半'); throw Object.assign(new Error('连接断开'), { status: 502 }); } };
    const backup = { stream: vi.fn() };
    await expect(agent.runAgent({ adapter: half, model: 'a', fallbacks: [{ adapter: backup, model: 'b' }], history: [], userText: 'x', tools: [], context: ctx, emit: () => {} })).rejects.toThrow('连接断开');
    const bad = { async stream() { throw Object.assign(new Error('参数不对'), { status: 400 }); } };
    await expect(agent.runAgent({ adapter: bad, model: 'a', fallbacks: [{ adapter: backup, model: 'b' }], history: [], userText: 'x', tools: [], context: ctx, emit: () => {} })).rejects.toThrow('参数不对');
    expect(backup.stream).not.toHaveBeenCalled();
  });

  it('备用模型也出错：一个个试完再报错', async () => {
    const down = (msg) => ({ async stream() { throw Object.assign(new Error(msg), { status: 503 }); } });
    const events = [];
    await expect(agent.runAgent({ adapter: down('一'), model: 'a', fallbacks: [{ adapter: down('二'), model: 'b' }, { adapter: down('三'), model: 'c' }], history: [], userText: 'x', tools: [], context: ctx, emit: (e) => events.push(e) })).rejects.toThrow('三');
    expect(events.filter((e) => e.type === 'fallback').map((e) => e.to)).toEqual(['b', 'c']);
  });
});

describe('长任务中途提醒', () => {
  it('提醒内容：用户这次的要求、计划做到哪、还剩哪几步', () => {
    const t = agent.progressReminder({ userText: '做一份 8 页的汇报 PPT', steps: [{ text: '查资料', status: 'done' }, { text: '写提纲', status: 'doing' }, { text: '生成 PPT', status: 'todo' }], toolCount: 6 });
    expect(t).toMatch(/已经调用了 6 次工具。用户这次要的是：“做一份 8 页的汇报 PPT”。计划共 3 步，已完成 1 步，还剩：写提纲；生成 PPT。/);
    expect(agent.progressReminder({ userText: 'x', steps: [], toolCount: 6 })).toMatch(/还没有列计划/);
    expect(agent.progressReminder({ userText: '长'.repeat(300), toolCount: 6 })).toMatch(/长{200}…/);
  });

  it('每调用 6 次工具附一次提醒（附在最后一条工具结果后面），工具少时不提醒', async () => {
    const seen = [];
    let n = 0;
    const adapter = { async stream({ messages, onText }) {
      seen.push(messages.map((m) => String(m.content)));
      if (++n <= 7) return { text: '', toolCalls: [call(String(n), 'noop', { n })], stop: 'tool_use' };
      onText('好了'); return { text: '好了', toolCalls: [], stop: 'end_turn' };
    } };
    const tools = [{ name: 'noop', description: '什么都不做', input_schema: { type: 'object', properties: { n: { type: 'number' } } }, run: async () => 'ok' }];
    await agent.runAgent({ adapter, model: 'm', history: [], userText: '整理资料', tools, context: ctx, emit: () => {} });
    const reminders = (msgs) => msgs.filter((c) => c.includes('进度提醒')).length;
    expect(reminders(seen[5])).toBe(0); // 调了 5 次：不提醒
    expect(reminders(seen[6])).toBe(1); // 第 6 次之后：提醒一次
    expect(seen[6].at(-1)).toMatch(/^ok\n\n（进度提醒：已经调用了 6 次工具。用户这次要的是：“整理资料”/);
    expect(reminders(seen[7])).toBe(1); // 第 7 次：不再重复
    const few = { async stream({ onText }) { onText('答'); return { text: '答', toolCalls: [], stop: 'end_turn' }; } };
    expect((await agent.runAgent({ adapter: few, model: 'm', history: [], userText: 'x', tools, context: ctx, emit: () => {} })).text).toBe('答');
  });
});

describe('项目规则文件', () => {
  it('读工作区根目录的“未央规则.md”，没有再找 AGENTS.md；空文件、读不到当没有', async () => {
    const files = { 'AGENTS.md': '用英文写代码注释', '未央规则.md': '﻿  文件一律存到 报告/ 目录\n称呼我王总  ' };
    const fs = { exists: async (p) => p in files, readText: async (p) => files[p] };
    expect(await loadRules(fs)).toEqual({ path: '未央规则.md', text: '文件一律存到 报告/ 目录\n称呼我王总', truncated: false });
    delete files['未央规则.md'];
    expect((await loadRules(fs)).path).toBe('AGENTS.md');
    files['AGENTS.md'] = '   ';
    expect(await loadRules(fs)).toBeNull();
    expect(await loadRules({ exists: async () => true, readText: async () => { throw new Error('坏了'); } })).toBeNull();
  });

  it('太长时截断并提示去读原文件；放进上下文时写明优先级', async () => {
    const r = await loadRules({ exists: async () => true, readText: async () => '规'.repeat(RULES_MAX + 10) });
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(RULES_MAX);
    const block = rulesBlock(r);
    expect(block).toMatch(/^## 项目规则（工作区 未央规则.md，用户写的长期规矩：照着做，优先于默认做法；和用户这次说的冲突时以这次为准）/);
    expect(block).toMatch(/用 read_file 读 未央规则.md/);
    expect(rulesBlock(null)).toBe('');
  });

  it('每轮自动带进上下文：工作区里有规则文件时出现在给模型的说明里', async () => {
    const ws = await import('../src/agent/workspace.js');
    await ws.write('未央规则.md', '所有报告都用公文格式');
    const { buildContext } = agent;
    const c = await buildContext('写个通知');
    expect(c.dynamic).toMatch(/## 项目规则（工作区 未央规则.md[\s\S]*所有报告都用公文格式/);
    expect(agent.STABLE_PROMPT).toMatch(/记进项目规则/);
  });
});

describe('干活时插话不打断', () => {
  it('认出问进度和要停下的话；别的话不算', async () => {
    const { STATUS_ASK, STOP_ASK, turnStatus } = await import('../src/core/interject.js');
    for (const t of ['好了吗', '好了吗？', '进度呢', '还要多久', '做完了吗？？', '在吗']) expect(STATUS_ASK.test(t), t).toBe(true);
    for (const t of ['好了吗，顺便把字调大', '查一下最近的新闻', '把第二页改一下']) expect(STATUS_ASK.test(t), t).toBe(false);
    for (const t of ['停', '先别做了', '取消！', 'stop']) expect(STOP_ASK.test(t), t).toBe(true);
    expect(STOP_ASK.test('停车场在哪')).toBe(false);
    expect(turnStatus({ t0: 0, steps: 5, status: '生成 PPT…' }, 125_000)).toBe('还在做，已经 2 分 5 秒、第 5 步，现在在生成 PPT');
    expect(turnStatus({ t0: 0, steps: 0, status: '' }, 8_000)).toBe('还在做，已经 8 秒');
  });

  it('干活中途收到的话：下一步开始前交给模型（附在工具结果后面），任务接着做，不重新开始', async () => {
    const inbox = [];
    const seen = [];
    let n = 0;
    const tools = [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: { n: { type: 'number' } } }, run: async () => { if (n === 1) inbox.push('字再大一点'); return 'ok'; } }];
    const adapter = { async stream({ messages, onText }) {
      seen.push(messages.at(-1).content);
      if (++n <= 2) return { text: '', toolCalls: [call(String(n), 'noop', { n })], stop: 'tool_use' };
      onText('做好了，字也调大了'); return { text: '做好了，字也调大了', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await agent.runAgent({ adapter, model: 'm', history: [], userText: '做个 PPT', tools, context: ctx, emit: () => {}, inbox });
    expect(r.text).toBe('做好了，字也调大了');
    expect(seen[1]).toMatch(/^ok\n\n（用户在你干活时发来：“字再大一点”。是补充或修改这件事就照着调整/);
    expect(seen.filter((c) => String(c).includes('字再大一点'))).toHaveLength(1); // 只交一次（之后留在前面的对话里，不重复附）
    expect(inbox).toEqual([]);
  });

  it('模型正要结束时又收到话：接着处理，不结束', async () => {
    const inbox = [];
    let n = 0;
    const adapter = { async stream({ messages, onText }) {
      n++;
      if (n === 1) { onText('PPT 做好了。'); inbox.push('再加一页总结'); return { text: 'PPT 做好了。', toolCalls: [], stop: 'end_turn' }; }
      expect(messages.at(-1)).toMatchObject({ role: 'user' });
      expect(messages.at(-1).content).toMatch(/“再加一页总结”/);
      onText('总结页也加上了。'); return { text: '总结页也加上了。', toolCalls: [], stop: 'end_turn' };
    } };
    const r = await agent.runAgent({ adapter, model: 'm', history: [], userText: '做个 PPT', tools: [], context: ctx, emit: () => {}, inbox });
    expect(n).toBe(2);
    expect(r.text).toMatch(/PPT 做好了。[\s\S]*总结页也加上了。/);
  });
});

it('执行器先等待检查点写入，再运行有副作用的工具',async()=>{
 const events=[];let n=0;const adapter={async stream(){return ++n===1?{text:'',toolCalls:[call('a','write_probe',{})],stop:'tool_use'}:{text:'完成',toolCalls:[],stop:'end_turn'};}};
 await agent.runAgent({adapter,model:'m',history:[],userText:'执行',context:ctx,tools:[{name:'write_probe',description:'x',input_schema:{type:'object',properties:{}},run:async()=>{events.push('run');return 'ok';}}],emit:()=>{},checkpoint:async e=>{await Promise.resolve();events.push(e.type);}});
 expect(events).toEqual(['tool_start','run','tool_end']);
});
