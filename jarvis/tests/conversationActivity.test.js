import { describe, it, expect } from 'vitest';
import { createConversationActivity } from '../src/ui/conversationActivity.js';
import { remoteSessions } from '../src/core/serverClient.js';

const memory = () => {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
};
describe('历史对话的真实状态', () => {
  it('首次旧记录不冒充未读；新回复才标记，打开后清除，用户消息不触发', () => {
    const activity = createConversationActivity({ storage: memory() });
    const row = { id: 'a', messages: [{ role: 'assistant', ts: 10 }] };
    expect(activity.state(row).unread).toBe(false);
    row.messages.push({ role: 'user', ts: 20 });
    expect(activity.state(row).unread).toBe(false);
    row.messages.push({ role: 'assistant', ts: 30 });
    expect(activity.state(row).unread).toBe(true);
    expect(activity.state(row, { current: true }).unread).toBe(false);
    expect(activity.state(row).unread).toBe(false);
  });
  it('排队和回答取真实状态；无任务不转圈，旧服务器只显示处理中', () => {
    const activity = createConversationActivity({ storage: memory() });
    expect(activity.state({ id: 'q', taskId: 't', taskStatus: 'queued' })).toMatchObject({ label: '排队中', status: 'queued' });
    expect(activity.state({ id: 'r', taskId: 't', taskStatus: 'running' })).toMatchObject({ label: '回答中', status: 'running' });
    expect(activity.state({ id: 'r', taskId: 't' }).label).toBe('处理中');
    expect(activity.state({ id: 'done' }).label).toBe('');
    expect(activity.state({ id: 'local' }, { activity: 'running' }).label).toBe('回答中');
  });
  it('已读跨刷新保留，运行位置互不污染；最多160条无正文', () => {
    const storage = memory(), a = createConversationActivity({ storage });
    a.state({ id: 'same', lastReplyAt: 1 }, { scope: 'server:a', current: true });
    a.flush();
    const b = createConversationActivity({ storage });
    expect(b.state({ id: 'same', lastReplyAt: 2 }, { scope: 'server:a' }).unread).toBe(true);
    expect(b.state({ id: 'same', lastReplyAt: 2 }, { scope: 'local' }).unread).toBe(false);
    for (let i = 0; i < 200; i++) b.state({ id: String(i), messages: [{ role: 'assistant', ts: i, content: '不可保存的正文' }] });
    b.flush();
    const saved = storage.getItem('jarvis.conversation-seen.v1');
    expect(JSON.parse(saved)).toHaveLength(160);
    expect(saved).not.toContain('不可保存');
  });
  it('损坏或不可写存储仍可显示和记录本次状态', () => {
    const a = createConversationActivity({ storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('full'); } } });
    expect(a.state({ id: 'a', lastReplyAt: 1 }).unread).toBe(false);
    expect(a.state({ id: 'a', lastReplyAt: 2 }).unread).toBe(true);
    expect(() => a.flush()).not.toThrow();
  });
  it('远端缓存保留回复时间但不能把旧活动当作仍在执行', async () => {
    const storage = memory();
    const client = { listSessions: async () => [{ id: 'a', taskId: 't', taskStatus: 'running', lastReplyAt: 8 }], getSession: async () => ({ id: 'a', messages: [], taskId: 't', taskStatus: 'running' }) };
    const remote = remoteSessions(client, { storage });
    expect((await remote.list())[0].taskStatus).toBe('running');
    await remote.get('a');
    remote.flush();
    const restored = remoteSessions(client, { storage });
    expect(restored.cachedList()[0]).toMatchObject({ lastReplyAt: 8 });
    expect(restored.cachedList()[0].taskStatus).toBeUndefined();
    expect(restored.cachedGet('a').taskId).toBeUndefined();
    expect(restored.cachedGet('a').taskStatus).toBeUndefined();
    // 先更新服务器、后更新客户端：旧客户端可能把新增字段按未知元数据缓存。
    const old = JSON.parse(storage.getItem('jarvis.server.cache.v1'));
    Object.assign(old.list[0], { taskId: 'old-task', taskStatus: 'running' });
    Object.assign(old.sessions.a, { taskId: 'old-task', taskStatus: 'queued' });
    storage.setItem('jarvis.server.cache.v1', JSON.stringify(old));
    const upgraded = remoteSessions(client, { storage });
    expect(upgraded.cachedList()[0].taskId).toBeUndefined();
    expect(upgraded.cachedList()[0].taskStatus).toBeUndefined();
    expect(upgraded.cachedGet('a').taskId).toBeUndefined();
    expect(upgraded.cachedGet('a').taskStatus).toBeUndefined();
    expect(upgraded.cachedList()[0].lastReplyAt).toBe(8);
    expect(createConversationActivity({ storage }).state(upgraded.cachedList()[0]).label).toBe('');
  });
});
