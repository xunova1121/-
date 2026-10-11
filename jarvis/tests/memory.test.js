import { describe, it, expect, beforeEach } from 'vitest';
import * as memory from '../src/agent/memory.js';
import { collection } from '../src/agent/store.js';

async function reset() {
  for (const c of ['memories', 'episodes', 'lessons', 'skills', 'events']) {
    const col = collection(c);
    for (const x of await col.all()) await col.delete(x.id);
  }
  await collection('kv').delete('core');
  memory.configureMemory({});
}
beforeEach(reset);

describe('记忆写入：新增 / 合并 / 更新', () => {
  it('重复内容合并为一条（只刷新）', async () => {
    const a = await memory.remember('用户喜欢简洁的回答', 'preference');
    const b = await memory.remember('用户喜欢简洁的回答。', 'preference', { importance: 5 });
    expect(a.action).toBe('ADD');
    expect(b.action).toBe('NOOP');
    const all = await memory.listAll();
    expect(all.memories).toHaveLength(1);
    expect(all.memories[0].importance).toBe(5);
  });

  it('同一属性的新说法取代旧值，旧值进入历史与归档', async () => {
    await memory.remember('用户住在上海', 'profile');
    const r = await memory.remember('用户住在杭州', 'profile');
    expect(r.action).toBe('UPDATE');
    expect(r.previous).toBe('用户住在上海');
    const all = await memory.listAll();
    expect(all.memories.map((m) => m.content)).toEqual(['用户住在杭州']);
    expect(all.memories[0].history[0].content).toBe('用户住在上海');
    expect(all.archived[0]).toMatchObject({ content: '用户住在上海', supersededBy: all.memories[0].id });
  });

  it('不同的偏好可以并存', async () => {
    await memory.remember('用户喜欢喝咖啡', 'preference');
    await memory.remember('用户喜欢爬山', 'preference');
    expect((await memory.listAll()).memories).toHaveLength(2);
  });

  it('属性识别', () => {
    expect(memory.attributeOf('用户叫老王')).toBe('name');
    expect(memory.attributeOf('用户在深圳工作')).toBe('city');
    expect(memory.attributeOf('用户是一名产品经理')).toBe('job');
    expect(memory.attributeOf('用户喜欢猫')).toBeNull();
  });

  it('忘记 = 归档（可恢复），删除才真正删掉', async () => {
    const m = await memory.remember('用户的车牌是沪A12345', 'fact');
    await memory.forget(m.id);
    let all = await memory.listAll();
    expect(all.memories).toHaveLength(0);
    expect(all.archived).toHaveLength(1);
    await memory.updateMemory(m.id, { validTo: null });
    expect((await memory.listAll()).memories).toHaveLength(1);
    await memory.deleteItem('memories', m.id);
    all = await memory.listAll();
    expect(all.memories.length + all.archived.length).toBe(0);
  });

  it('兼容 v1 的旧记录', async () => {
    await collection('memories').put({ id: 'old1', content: '用户喜欢蓝色', category: 'preference', ts: Date.now() - 1000, uses: 0 });
    const all = await memory.listAll();
    expect(all.memories[0]).toMatchObject({ id: 'old1', importance: 3, history: [], validTo: null });
  });
});

describe('检索与打分', () => {
  it('相关度为主，重要度与新近度加权；钉住的即使不相关也会带上', async () => {
    const at = Date.now();
    const items = [
      { id: 'a', content: '用户喜欢喝咖啡', importance: 2, lastUsed: at - 200 * 86400000 },
      { id: 'b', content: '用户每天早上喝咖啡', importance: 5, lastUsed: at },
      { id: 'c', content: '用户养了一只猫', importance: 3, lastUsed: at, pinned: true }
    ];
    const r = memory.score(items, '咖啡', (x) => x.content, { at });
    expect(r.map((x) => x.id)).toContain('c'); // 钉住
    expect(r.findIndex((x) => x.id === 'b')).toBeLessThan(r.findIndex((x) => x.id === 'a'));
  });

  it('有语义向量时，意思相近也能找到', async () => {
    const vocab = { 上海: [1, 0, 0], 魔都: [1, 0, 0], 咖啡: [0, 1, 0] };
    const embed = async (texts) => texts.map((t) => Object.entries(vocab).reduce((v, [w, e]) => (t.includes(w) ? v.map((x, i) => x + e[i]) : v), [0, 0, 0.01]));
    memory.configureMemory({ embedder: { model: 'fake', embed } });
    await memory.remember('用户在上海工作', 'profile');
    await memory.remember('用户爱喝咖啡', 'preference');
    const r = await memory.recall('我在魔都上班');
    expect(r.memories[0].content).toBe('用户在上海工作');
  });

  it('上下文：核心记忆、身份偏好、相关对话片段；取用后巩固', async () => {
    await memory.setCore('human', '称呼：老王；产品经理');
    await memory.remember('用户叫老王', 'profile', { importance: 5 });
    await memory.addEpisode({ summary: '帮用户写了季度汇报 PPT', topics: ['PPT', '汇报'] });
    const ctx = await memory.contextFor('再做一份汇报 PPT');
    expect(ctx.core.human).toContain('老王');
    expect(ctx.memories.map((m) => m.content)).toContain('用户叫老王');
    expect(ctx.episodes[0].summary).toContain('季度汇报');
    await memory.contextFor('老王');
    await new Promise((r) => setTimeout(r, 20));
    expect((await memory.listAll()).memories[0].uses).toBeGreaterThan(0);
  });
});

describe('自动整理', () => {
  it('离线：规则抽取自我介绍与偏好，并写对话摘要', async () => {
    const r = await memory.reflect([{ role: 'user', content: '我叫小林，我在杭州工作。我比较喜欢简洁的回答' }, { role: 'assistant', content: '好的' }]);
    const contents = r.memories.map((m) => m.content);
    expect(contents).toEqual(expect.arrayContaining(['用户叫小林', '用户在杭州工作', '用户喜欢简洁的回答']));
    expect(r.episode.summary).toContain('我叫小林');
  });

  it('有大模型时按模型输出整理（并与已有记忆合并）', async () => {
    await memory.remember('用户住在上海', 'profile');
    memory.configureMemory({
      llm: async ({ prompt }) => {
        expect(prompt).toContain('我搬到北京了');
        return '好的：{"memories":[{"content":"用户住在北京","category":"profile","importance":4}],"summary":"用户说搬家到北京，助手更新了地址","topics":["搬家"]}';
      }
    });
    const r = await memory.reflect([{ role: 'user', content: '我搬到北京了' }]);
    expect(r.memories[0]).toMatchObject({ action: 'UPDATE', content: '用户住在北京' });
    expect(r.episode).toMatchObject({ summary: '用户说搬家到北京，助手更新了地址', topics: ['搬家'] });
  });

  it('模型输出不是 JSON 时退回规则', async () => {
    memory.configureMemory({ llm: async () => '抱歉我不会' });
    const r = await memory.reflect([{ role: 'user', content: '我叫阿杰' }]);
    expect(r.memories[0].content).toBe('用户叫阿杰');
  });
});

describe('维护与备份', () => {
  it('长期不用、重要度低的记忆归档；钉住或重要的保留', async () => {
    const old = Date.now() - 200 * 86400000;
    const put = (id, extra) => collection('memories').put({ id, content: id, category: 'fact', ts: old, lastUsed: old, uses: 0, importance: 2, validTo: null, ...extra });
    await put('低');
    await put('钉住', { pinned: true });
    await put('重要', { importance: 5 });
    const r = await memory.maintain();
    expect(r.archived).toBe(1);
    const all = await memory.listAll();
    expect(all.memories.map((m) => m.id).sort()).toEqual(['重要', '钉住']);
  });

  it('导出 / 导入', async () => {
    await memory.remember('用户喜欢猫', 'preference');
    await memory.setCore('persona', '用“您”称呼');
    const data = await memory.exportAll();
    expect(data.format).toBe('jarvis-memory');
    await reset();
    const r = await memory.importAll(JSON.parse(JSON.stringify(data)));
    expect(r.memories).toBe(1);
    expect((await memory.getCore()).persona).toBe('用“您”称呼');
    await expect(memory.importAll({})).rejects.toThrow(/备份/);
  });
});
