/** 说一句话删某段时间的对话：先列清单、用户确认才删，进回收站留 7 天（用户 2026-10-30） */
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import * as sessions from '../src/agent/sessions.js';
import { createConversationTrashTools, parseBeijing, CONFIRM_DELETE } from '../src/agent/conversationTrashTools.js';
import { evaluationTools } from '../server/evaluation.mjs';

const at = (s) => Date.parse(s.replace(' ', 'T') + ':00+08:00');
async function make(title, time, extra = {}) {
  const s = { ...sessions.create(), title, titleSet: true, ...extra };
  s.messages.push({ role: 'user', content: title + '的内容', ts: at(time) }, { role: 'assistant', content: '好', ts: at(time) + 60000 });
  await sessions.save(s);
  return s;
}
const tool = (tools, name) => tools.find((t) => t.name === name);

describe('时间按北京时间', () => {
  it('一天 = 北京时间 0 点到 23:59:59.999', () => {
    expect(parseBeijing('2026-10-25')).toBe(at('2026-10-25 00:00'));
    expect(parseBeijing('2026-10-25', { end: true })).toBe(at('2026-10-26 00:00') - 1);
    expect(parseBeijing('2026-10-25 14:30')).toBe(at('2026-10-25 14:30'));
    expect(parseBeijing('25号')).toBeNull();
  });
  it('只认明确的确认说法', () => {
    for (const t of ['确认删除', '确定删吧', '可以删了']) expect(CONFIRM_DELETE.test(t)).toBe(true);
    for (const t of ['嗯', '好', '先别删']) expect(CONFIRM_DELETE.test(t)).toBe(false);
  });
});

describe('删对话：两步确认、进回收站、能恢复', () => {
  it('先列清单不删；用户确认后只删列过的、当前这段不删；能恢复', async () => {
    const a = await make('周六股票', '2026-10-25 09:00');
    const b = await make('周六天气', '2026-10-25 20:30');
    const keep = await make('周日周报', '2026-10-26 10:00');
    const current = await make('当前对话', '2026-10-25 11:00');
    const tools = createConversationTrashTools();
    const del = tool(tools, 'delete_conversations');
    const list = await del.run({ from: '2026-10-25', to: '2026-10-25' }, { sessionId: current.id, rawRequestText: '把10月25号的对话都删了' });
    expect(list).toMatch(/找到 2 段对话（还没删）/);
    expect(list).toContain('周六股票');
    expect(list).not.toContain('当前对话');
    expect(await sessions.get(a.id)).toBeTruthy();
    // 没明确确认：不删
    expect(await del.run({ from: '2026-10-25', to: '2026-10-25', confirm: true }, { sessionId: current.id, rawRequestText: '嗯' })).toMatch(/没有删任何东西/);
    expect(await sessions.get(a.id)).toBeTruthy();
    // 这期间新出现的同一天对话：没列给用户看过，不删
    const late = await make('后来补的', '2026-10-25 22:00');
    const done = await del.run({ from: '2026-10-25', to: '2026-10-25', confirm: true }, { sessionId: current.id, rawRequestText: '确认删除' });
    expect(done).toMatch(/已删除 2 段对话/);
    expect(await sessions.get(a.id)).toBeFalsy();
    expect(await sessions.get(b.id)).toBeFalsy();
    expect(await sessions.get(late.id)).toBeTruthy();
    expect(await sessions.get(keep.id)).toBeTruthy();
    expect(await sessions.get(current.id)).toBeTruthy();
    // 回收站里有，能恢复
    const trash = await sessions.listTrash();
    expect(trash.map((x) => x.title).sort()).toEqual(['周六天气', '周六股票']);
    expect(await tool(tools, 'list_deleted_conversations').run({})).toContain('周六股票');
    expect(await tool(tools, 'restore_conversations').run({ ids: [a.id] })).toMatch(/已恢复 1 段/);
    expect((await sessions.get(a.id)).messages.length).toBe(2);
    expect((await sessions.listTrash()).map((x) => x.id)).toEqual([b.id]);
  });
  it('没先列清单就带 confirm：不删', async () => {
    const s = await make('孤立', '2026-10-20 09:00');
    const del = tool(createConversationTrashTools(), 'delete_conversations');
    expect(await del.run({ from: '2026-10-20', confirm: true }, { sessionId: 'x', rawRequestText: '确认删除' })).toMatch(/没有删任何东西/);
    expect(await sessions.get(s.id)).toBeTruthy();
  });
  it('关键词只删带这个词的', async () => {
    await make('股票复盘', '2026-10-21 09:00');
    await make('天气闲聊', '2026-10-21 10:00');
    const list = await tool(createConversationTrashTools(), 'delete_conversations').run({ from: '2026-10-21', keyword: '股票' }, { sessionId: 'x', rawRequestText: '删掉21号关于股票的对话' });
    expect(list).toMatch(/找到 1 段/);
    expect(list).toContain('股票复盘');
  });
  it('7 天后彻底删除', async () => {
    const s = await make('很早的', '2026-10-10 09:00');
    const t0 = Date.parse('2026-10-11T00:00:00Z');
    await sessions.trash(s.id, t0);
    expect((await sessions.listTrash(t0 + 6 * 86400000)).some((x) => x.id === s.id)).toBe(true);
    expect((await sessions.listTrash(t0 + 7 * 86400000)).some((x) => x.id === s.id)).toBe(false);
    expect(await sessions.restore(s.id)).toBeNull();
  });
  it('评测会话里不能删、不能恢复', async () => {
    const tools = evaluationTools(createConversationTrashTools(), 'eval-1');
    for (const t of tools) expect(await t.run({ from: '2026-10-25' }, {})).toMatch(/评测隔离/);
  });
});
