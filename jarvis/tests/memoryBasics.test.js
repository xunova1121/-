/** 真实问题：用户问“我多大了”，未央说不知道（明明记过 35 岁）；问“我搜过哪些企业”只列出一半，还编了一个 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as memory from '../src/agent/memory.js';
import * as sessions from '../src/agent/sessions.js';
import { collection } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { buildContext } from '../src/agent/agent.js';

beforeEach(async () => {
  for (const c of ['memories', 'episodes', 'lessons', 'skills', 'events', 'sessions']) await collection(c).clear();
  await collection('kv').delete('core');
  memory.configureMemory({});
});

describe('基本情况每轮都带上（不靠接口）', () => {
  it('偏好记得再多，年龄、住址、家人也不会被挤掉；不用和问题像', async () => {
    await memory.remember('用户今年35岁', 'fact', { importance: 4 });
    await memory.remember('用户住在南京', 'profile', { importance: 4 });
    await memory.remember('用户的妻子在做产检', 'fact', { importance: 3 });
    for (const p of ['用户喜欢简洁回答', '用户希望被称呼为长乐', '用户不喜欢编数字', '用户希望先倾听', '用户喜欢结论放前面', '用户希望标明资料不足']) await memory.remember(p, 'preference', { importance: 5 });
    const ctx = await memory.contextFor('帮我想想周末去哪');
    const basics = ctx.basics.map((m) => m.content);
    expect(basics).toEqual(expect.arrayContaining(['用户今年35岁', '用户住在南京', '用户的妻子在做产检']));
    const prompt = (await buildContext('帮我想想周末去哪')).dynamic;
    expect(prompt).toContain('## 用户的基本情况');
    expect(prompt.match(/用户今年35岁/g)).toHaveLength(1); // 不在“相关记忆”里重复
  });
  it('基本情况有上限，不会把上下文撑爆', async () => {
    for (let i = 0; i < 30; i++) await memory.remember(`用户的第${i}个身份信息：在某某单位第${i}个岗位工作了很多年`, 'profile', { importance: 3 });
    const { basics } = await memory.contextFor('你好');
    expect(basics.length).toBeLessThanOrEqual(memory.BASICS_LIMIT.items);
    expect(basics.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(memory.BASICS_LIMIT.chars);
  });
  it('本地同义词：“我多大了”能找到“35岁”，“我住哪”能找到“住在南京”', async () => {
    await memory.remember('用户今年35岁', 'other', { importance: 2 });
    await memory.remember('用户住在南京江宁', 'other', { importance: 2 });
    expect((await memory.recall('我多大了')).memories.map((m) => m.content)).toContain('用户今年35岁');
    expect((await memory.recall('我住哪')).memories.map((m) => m.content)).toContain('用户住在南京江宁');
    expect(memory.expandQuery('今天天气')).toBe('今天天气');
  });
});

describe('按条翻看用户说过的话（列全用）', () => {
  const day = (d) => new Date(`2026-10-${d}T10:00:00+08:00`).getTime();
  beforeEach(async () => {
    const mk = async (id, title, texts) => sessions.save({ id, title, titleSet: true, createdAt: day(1), updatedAt: day(20), pinned: false, messages: texts.flatMap(([d, t]) => [{ role: 'user', content: t, ts: day(d) }, { role: 'assistant', content: '好的', ts: day(d) + 1 }]) });
    await mk('s1', '查公司', [['02', '查一下江苏天合云商股份有限公司'], ['03', 'SpaceX 市值多少']]);
    await mk('s2', '股票', [['05', '时代万恒今天怎么样'], ['06', '世龙实业有公告吗'], ['07', '今天天气']]);
    await mk('s3', '核实', [['09', '帮我核实江苏省供销合作总社的这组信息']]);
  });
  it('一条不漏、按时间排；同一段对话里的几条都在（以前每段对话只取一条）', async () => {
    const r = await sessions.listUserMessages({});
    expect(r.total).toBe(6);
    expect(r.items.map((m) => m.text)).toEqual(['查一下江苏天合云商股份有限公司', 'SpaceX 市值多少', '时代万恒今天怎么样', '世龙实业有公告吗', '今天天气', '帮我核实江苏省供销合作总社的这组信息']);
  });
  it('关键词（含任意一个就算）、日期范围、分页', async () => {
    expect((await sessions.listUserMessages({ query: '公司 合作社 SpaceX' })).total).toBe(2);
    expect((await sessions.listUserMessages({ query: '公司 总社 SpaceX' })).total).toBe(3);
    expect((await sessions.listUserMessages({ from: day('05'), to: day('06') })).total).toBe(2);
    const p = await sessions.listUserMessages({ pageSize: 4, page: 2 });
    expect([p.page, p.pages, p.items.length]).toEqual([2, 2, 2]);
  });
  it('工具：说清一共多少条、哪段时间、还有没有下一页；不算正在问的这一句', async () => {
    await sessions.save({ id: 'now', title: '现在', titleSet: true, createdAt: day(20), updatedAt: day(20), pinned: false, messages: [{ role: 'user', content: '我搜索过哪些企业', ts: day(20) }] });
    const tool = createTools({ metrics: async () => ({}) }).find((t) => t.name === 'list_my_messages');
    const out = await tool.run({}, { sessionId: 'now' });
    expect(out).toMatch(/^共 6 条（2026\/10\/2.*到 2026\/10\/9.*第 1\/1 页；已经是最后一页/);
    expect(out).toContain('江苏天合云商');
    expect(out).not.toContain('我搜索过哪些企业');
    expect(await tool.run({ query: '金种子' }, { sessionId: 'now' })).toContain('没有含“金种子”');
  });
});

describe('向量：一次补完、出错看得见', () => {
  it('填了 Key 后一次把没向量的记忆都补上（以前每次只补 50 条）', async () => {
    for (let i = 0; i < 70; i++) await memory.remember(`记忆第${i}条：用户提过的第${i}件小事`, 'other', { importance: 2 });
    let calls = 0;
    memory.configureMemory({ embedder: { model: 'zhipu:embedding-3', embed: async (texts) => { calls++; return texts.map(() => [0.1, 0.2]); } } });
    expect(await memory.backfillVectors()).toBe(70);
    expect(calls).toBe(5); // 16 条一批
    expect(await memory.vectorStatus()).toMatchObject({ model: 'zhipu:embedding-3', total: 70, embedded: 70, lastError: null });
  });
  it('向量服务出错：记下原因，模型页能看到', async () => {
    await memory.remember('用户今年35岁', 'fact');
    memory.configureMemory({ embedder: { model: 'zhipu:embedding-3', embed: async () => { throw new Error('向量服务返回 401'); } } });
    expect(await memory.backfillVectors()).toBe(0);
    expect((await memory.vectorStatus()).lastError.message).toBe('向量服务返回 401');
  });
  it('只换向量服务不动整理用的大模型', () => {
    const llm = async () => '{}';
    memory.configureMemory({ llm });
    memory.setEmbedder({ model: 'x', embed: async () => [] });
    expect(memory.memoryEngine()).toEqual({ llm: true, embeddings: 'x' });
  });
});
