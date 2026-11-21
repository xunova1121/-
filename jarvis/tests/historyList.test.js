/** 2026-11-18 用户：电脑老是掉线、对话全没了——列表一次读不到就被清空成“历史对话暂不可用” */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadHistory, HISTORY_REFRESH_MS, STALE_HINT, LOGIN_HINT, EMPTY_HINT, refreshInterval, sessionListRow } from '../src/ui/historyList.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const timeout = () => Promise.reject(Object.assign(new Error('连服务器超时（5 秒没有回应）'), { kind: 'timeout' }));

describe('对话列表读不到时不清空', () => {
  it('列表副本只保留显示所需的元数据，兼容本机会话、云端计数和旧角色名', () => {
    const local = sessionListRow({ id: 'a', messages: [{ role: 'agent', ts: 42, content: '原回复' }, { role: 'user', ts: 45 }] });
    expect(local).toMatchObject({ id: 'a', count: 2, lastReplyAt: 42 });
    expect(local).not.toHaveProperty('messages');
    const server = { id: 'b', messages: [], count: 90, lastReplyAt: 99, taskStatus: 'queued', agentId: 'news' };
    expect(sessionListRow(server)).toMatchObject({ id: 'b', count: 90, lastReplyAt: 99, taskStatus: 'queued', agentId: 'news' });
  });
  it('读到了：用新列表', async () => {
    expect(await loadHistory({ list: async () => [{ id: 'a' }], shown: () => [{ id: 'old' }] })).toEqual({ rows: [{ id: 'a' }], stale: false, hint: '' });
  });
  it('超时：先用上次显示的，其次用本机副本，并提示是旧列表', async () => {
    expect(await loadHistory({ list: timeout, shown: () => [{ id: 'shown' }], cached: () => [{ id: 'cache' }] })).toEqual({ rows: [{ id: 'shown' }], stale: true, hint: STALE_HINT });
    expect(await loadHistory({ list: timeout, shown: () => null, cached: () => [{ id: 'cache' }] })).toEqual({ rows: [{ id: 'cache' }], stale: true, hint: STALE_HINT });
  });
  it('手上什么都没有：说读不到，不说“还没有对话”；登录失效照常提示重新登录', async () => {
    expect(await loadHistory({ list: timeout })).toEqual({ rows: null, stale: false, hint: EMPTY_HINT });
    expect(EMPTY_HINT).not.toContain('还没有');
    expect(await loadHistory({ list: () => Promise.reject(Object.assign(new Error('x'), { status: 401 })), shown: () => [{ id: 'a' }] })).toEqual({ rows: null, stale: false, hint: LOGIN_HINT });
  });
  it('电脑左栏和对话面板都用它；不再每 3 秒拉一次，切回窗口时刷新', () => {
    const wb = fs.readFileSync(path.join(ROOT, 'src/ui/workbench.js'), 'utf8');
    const panel = fs.readFileSync(path.join(ROOT, 'src/ui/sessionsPanel.js'), 'utf8');
    expect(HISTORY_REFRESH_MS).toBeGreaterThanOrEqual(30000);
    // 连服务器才降频；本机列表照旧 3 秒（e2e/pc-agent-navigation 直接写本机库后要很快出现在左栏）
    expect(refreshInterval(true)).toBe(HISTORY_REFRESH_MS);
    expect(refreshInterval(false)).toBe(3000);
    expect(wb).toContain('refreshInterval(sessions.usingRemote())');
    expect(wb).toContain('loadHistory(');
    expect(wb).not.toContain('历史对话暂不可用');
    expect(wb).not.toMatch(/refresh\(\)\.catch\(\(\)=>\{\}\),3000\)/);
    expect(wb).toContain("addEventListener('visibilitychange'");
    expect(panel).toContain('loadHistory(');
    expect(panel).not.toContain('sessions.search(query).catch(() => [])');
  });
});
