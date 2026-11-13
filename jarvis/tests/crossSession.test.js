import { describe, it, expect, beforeEach } from 'vitest';
import * as sessions from '../src/agent/sessions.js';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';
import { buildContext } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';

async function reset() {
  for (const c of ['sessions', 'memories', 'episodes', 'lessons', 'skills', 'events']) {
    const col = collection(c);
    for (const x of await col.all()) await col.delete(x.id);
  }
  memory.configureMemory({});
}
beforeEach(reset);

async function convo(title, pairs, updatedAt = Date.now()) {
  const s = sessions.create();
  s.title = title;
  s.titleSet = true;
  s.updatedAt = updatedAt;
  pairs.forEach(([u, a], i) => s.messages.push({ role: 'user', content: u, ts: updatedAt + i * 2 }, { role: 'assistant', content: a, ts: updatedAt + i * 2 + 1 }));
  await sessions.save(s);
  return s;
}

describe('跨对话检索', () => {
  it('在其他对话的原话里找相关的一问一答，不含当前对话，每段对话最多一处', async () => {
    const a = await convo('装修预算', [['我家装修预算 18 万，客厅想用奶油风', '好的，奶油风客厅建议……'], ['厨房橱柜预算多少合适', '一般 2-3 万']]);
    const b = await convo('周报', [['帮我写周报', '已生成周报.docx']]);
    const hits = await sessions.searchMessages('装修预算', { k: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sessionId: a.id, title: '装修预算' });
    expect(hits[0].user).toContain('18 万');
    expect(await sessions.searchMessages('装修预算', { exclude: a.id })).toEqual([]);
    expect((await sessions.recent({ exclude: b.id })).map((s) => s.id)).toEqual([a.id]);
  });

  it('新对话的上下文里带上最近的对话、相关原话、没做完的事', async () => {
    const a = await convo('装修预算', [['我家装修预算 18 万，客厅想用奶油风', '好的']]);
    await memory.reflect([{ role: 'user', content: '先到这，明天再帮我算一下厨房的报价' }], { session: { id: a.id, title: '装修预算' } });
    const ctx = await buildContext('装修预算还剩多少', { sessionId: 'current', turns: 0 });
    expect(ctx.dynamic).toContain('## 过往对话里的相关原话');
    expect(ctx.dynamic).toContain('18 万');
    expect(ctx.dynamic).toContain(`id: ${a.id}`);
    expect(ctx.dynamic).toContain('## 最近的其他对话');
    expect(ctx.dynamic).toMatch(/## 之前对话里说好以后再做的事.*\n- 明天再帮我算一下厨房的报价（来自「装修预算」/);
    expect(ctx.dynamic).toMatch(/## 相关的过往对话\n- .*「装修预算」/);
    // 对话进行中（超过 2 轮）不再列最近对话和待办，避免干扰
    const later = await buildContext('装修预算还剩多少', { sessionId: 'current', turns: 5 });
    expect(later.dynamic).not.toContain('## 最近的其他对话');
    expect(later.dynamic).not.toContain('说好以后再做');
  });

  it('没做完的事：后来的对话里做了就自动划掉', async () => {
    await memory.reflect([{ role: 'user', content: '下次再帮我整理一下发票' }], { session: { id: 's1', title: '报销' } });
    expect((await memory.openItems()).map((o) => o.text)).toEqual(['下次再帮我整理一下发票']);
    expect(memory.ruleOpen(['好的，回头继续写第三章。今天天气不错'])).toEqual(['回头继续写第三章']);
    await memory.reflect([{ role: 'user', content: '现在帮我整理一下发票吧' }], { session: { id: 's2', title: '发票' } });
    expect(await memory.openItems()).toEqual([]);
  });

  it('search_conversations / read_conversation 工具', async () => {
    const a = await convo('旅行计划', [['五一去成都，预算 5000', '行程：第一天宽窄巷子……'], ['酒店订在春熙路', '好的']]);
    const tools = createTools({ metrics: async () => ({}), currentSessionId: () => 'other' });
    const search = tools.find((t) => t.name === 'search_conversations');
    const read = tools.find((t) => t.name === 'read_conversation');
    const r = await search.run({ query: '成都预算' });
    expect(r).toContain(`id: ${a.id}「旅行计划」`);
    expect(r).toContain('五一去成都');
    const full = await read.run({ id: a.id });
    expect(full).toContain('对话「旅行计划」（4 条）');
    expect(full).toContain('酒店订在春熙路');
    await expect(read.run({ id: 'nope' })).rejects.toThrow(/找不到对话/);
  });
});
