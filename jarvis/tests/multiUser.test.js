import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccessSecurity, legacyAccessToken } from '../server/accessSecurity.mjs';
import { createUserStore, runAsUser } from '../server/userScope.mjs';
import { createEvaluationAccess } from '../server/evaluationAccess.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as knowledge from '../src/agent/knowledge.js';
import * as memory from '../src/agent/memory.js';
import * as habits from '../src/agent/habits.js';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { userStorageSuffix, privateStorage } from '../src/core/userStorage.js';
import { currentUser } from '../server/userScope.mjs';
import * as scheduler from '../src/agent/scheduler.js';
import * as sessions from '../src/agent/sessions.js';
import { createServerSchedules, notices } from '../server/serverSchedules.mjs';

let dir;
const password = 'test-owner-only';
const req = token => ({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer ' + token }, socket: { remoteAddress: '127.0.0.1' } });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-users-')); });
afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });
function accounts() {
  const security = createAccessSecurity({ dataDir: dir, password });
  const owner = security.authenticate(req(legacyAccessToken(password)));
  const a = security.users.create(owner, { name: '甲' }), b = security.users.create(owner, { name: '乙' });
  return { security, owner, a, b };
}

describe('稳定用户身份与旧版兼容', () => {
  it('同一访问码的两台设备绑定同一ID；重启、主密码变更均不丢成员归属', () => {
    const { security, owner, a } = accounts();
    const first = security.login(req(''), a.accessCode), second = security.login(req(''), a.accessCode);
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ userId: a.id, role: 'member' });
    expect(second.userId).toBe(a.id);
    expect(security.authenticate(req(first.token))).toMatchObject({ userId: a.id, role: 'member' });
    const restarted = createAccessSecurity({ dataDir: dir, password });
    expect(restarted.authenticate(req(first.token))?.userId).toBe(a.id);
    expect(restarted.authenticate(req(legacyAccessToken(password)))?.userId).toBe('owner');
    const changed = createAccessSecurity({ dataDir: dir, password: 'test-new-owner' });
    expect(changed.login(req(''), a.accessCode).userId).toBe(a.id);
    expect(JSON.stringify(security.users.list(owner))).not.toContain(a.accessCode);
    expect(fs.readFileSync(path.join(dir, 'access-security.json'), 'utf8')).not.toContain(a.accessCode);
  });
  it('成员不能管理用户；停用/重置撤销旧设备和下载票据，不清空数据', () => {
    const { security, owner, a } = accounts();
    const session = security.login(req(''), a.accessCode), principal = security.authenticate(req(session.token));
    expect(() => security.users.create(principal, { name: '越权' })).toThrow(/管理员/);
    const ticket = security.ticket(principal, '/api/files/raw?path=demo.txt');
    const result = security.users.update(owner, a.id, 'reset');
    expect(result.id).toBe(a.id);
    expect(security.authenticate(req(session.token))).toBeNull();
    expect(security.authenticate({ ...req(''), url: '/api/files/raw?path=demo.txt&ticket=' + ticket.ticket })).toBeNull();
    expect(() => security.login(req(''), a.accessCode)).toThrow(/密码不对/);
    expect(security.login(req(''), result.accessCode).userId).toBe(a.id);
    security.users.update(owner, a.id, 'disable');
    expect(() => security.login(req(''), result.accessCode)).toThrow(/密码不对/);
    security.users.update(owner, a.id, 'enable');
    expect(security.login(req(''), result.accessCode).userId).toBe(a.id);
  });
});

it('相同文件/记录ID、知识检索缓存、习惯、模型回调与延迟绑定不串用户', async () => {
  const { security, a, b } = accounts();
  const store = createUserStore(dir);
  useBackend(createEvaluationAccess({ store, dataDir: dir, security }).store);
  let bound;
  await Promise.all([a, b].map(user => runAsUser(user.id, async () => {
    const label = user.name;
    await collection('kv').put({ id: 'same', content: label });
    await knowledge.addDocument({ name: label, text: label + '的差旅报销金额为二百元。' });
    memory.configureMemory({ embedder: { model: label } });
    await habits.record({ app: label, ts: Date.now() });
    if (user.id === a.id) bound = collection('kv').bind();
    await new Promise(resolve => setTimeout(resolve, user.id === a.id ? 30 : 5));
    expect((await collection('kv').get('same')).content).toBe(label);
    expect((await knowledge.search('差旅报销', 5)).every(row => row.name === label)).toBe(true);
    expect(memory.memoryEngine().embeddings).toBe(label);
    expect(Object.keys((await habits.load()).apps)).toEqual([label]);
  })));
  await runAsUser(b.id, () => bound.put({ id: 'late', content: '甲' }));
  expect(await runAsUser(b.id, () => store.get('kv', 'late'))).toBeUndefined();
  expect(await runAsUser(a.id, () => store.get('kv', 'late'))).toMatchObject({ content: '甲' });
  expect(await store.get('kv', 'same')).toBeUndefined();
  expect(() => runAsUser('../../store', () => {})).toThrow();
});

it('两人同时真实进入执行器；同名会话/请求互不合并，越权停止和事件读取失败', async () => {
  const { security, a, b } = accounts();
  const store = createUserStore(dir);
  useBackend(store);
  const started = new Set(), releases = new Map();
  const adapter = { kind: 'mock', async stream({ onText, signal }) {
    const { currentUser } = await import('../server/userScope.mjs');
    const id = currentUser(); started.add(id);
    await new Promise(resolve => { releases.set(id, resolve); signal.addEventListener('abort', resolve, { once: true }); });
    onText?.('已收到。'); return { text: '已收到。', toolCalls: [], stop: 'end_turn' };
  } };
  const { currentUser } = await import('../server/userScope.mjs');
  const runner = createTaskRunner({ getConfig: async () => ({ provider: 'mock', models: {}, keys: {}, autoMemory: false }), makeAdapter: () => ({ adapter, model: 'fixture' }), makeTools: () => [], maxRunning: 2, userAccess: { current: currentUser, run: runAsUser, active: security.users.active } });
  try {
    const ta = await runAsUser(a.id, () => runner.start({ sessionId: 'same', requestId: 'same-request', text: '你好甲' }));
    const tb = await runAsUser(b.id, () => runner.start({ sessionId: 'same', requestId: 'same-request', text: '你好乙' }));
    for (let i = 0; i < 100 && started.size < 2; i++) await new Promise(r => setTimeout(r, 10));
    expect(started).toEqual(new Set([a.id, b.id]));
    expect(ta.id).not.toBe(tb.id);
    expect(runner.busy).toBe(true);
    expect(runner.list()).toEqual([]); // 主人的接口不返回成员任务正文。
    expect(runAsUser(b.id, () => runner.stop(ta.id))).toBe(false);
    expect(runAsUser(b.id, () => runner.events(ta.id))).toBeNull();
    expect(runAsUser(a.id, () => runner.list()).map(t => t.id)).toEqual([ta.id]);
    releases.get(a.id)(); releases.get(b.id)();
    await runner.settled();
    expect((await runAsUser(a.id, () => store.get('sessions', 'same'))).messages[0].content).toBe('你好甲');
    expect((await runAsUser(b.id, () => store.get('sessions', 'same'))).messages[0].content).toBe('你好乙');
  } finally { runner.stopUser(a.id); runner.stopUser(b.id); for (const release of releases.values()) release(); await runner.settled(); }
});

it('换成员后本地缓存与模型配置另存，主人原缓存和登录设置保留', () => {
  const map = new Map([['jarvis.llm.v1', 'owner-private']]);
  const storage = { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
  const id = 'u_' + 'a'.repeat(24);
  storage.setItem('jarvis.server.v1', JSON.stringify({ enabled: true, url: 'https://example.test', userId: id }));
  expect(userStorageSuffix(storage)).toContain(id);
  const member = privateStorage(storage);
  expect(member.getItem('jarvis.llm.v1')).toBeUndefined();
  member.setItem('jarvis.llm.v1', 'member-private');
  expect(storage.getItem('jarvis.llm.v1')).toBe('owner-private');
  expect(member.getItem('jarvis.server.v1')).toBe(storage.getItem('jarvis.server.v1'));
  storage.setItem('jarvis.server.v1', JSON.stringify({ enabled: false, url: 'https://example.test', userId: id }));
  expect(privateStorage(storage).getItem('jarvis.llm.v1')).toBe('member-private');
});

it('旧版无userId的设备登录和根目录原数据升级后仍归主人', async () => {
  const security = createAccessSecurity({ dataDir: dir, password });
  const old = security.login(req(''), password);
  const filename = path.join(dir, 'access-security.json');
  const state = JSON.parse(fs.readFileSync(filename));
  for (const session of state.sessions) delete session.userId;
  delete state.users;
  fs.writeFileSync(filename, JSON.stringify(state));
  const store = createUserStore(dir);
  await store.put('sessions', { id: 'legacy', title: '旧会话', messages: [{ role: 'user', content: '旧内容' }] });
  const upgraded = createAccessSecurity({ dataDir: dir, password });
  expect(upgraded.authenticate(req(old.token))).toMatchObject({ role: 'owner', userId: 'owner' });
  const a = upgraded.users.create(upgraded.authenticate(req(old.token)), { name: '新成员' });
  expect(await runAsUser(a.id, () => store.get('sessions', 'legacy'))).toBeUndefined();
  expect(await store.get('sessions', 'legacy')).toMatchObject({ title: '旧会话' });
});

it('排队在用户间轮流调度，取消别人的排队任务不会生效', async () => {
  const { security, a, b } = accounts();
  useBackend(createUserStore(dir));
  const calls = [], resumes = [];
  const adapter = { kind: 'mock', async stream({ onText, signal }) {
    calls.push(currentUser());
    await new Promise(resolve => { resumes.push(resolve); signal.addEventListener('abort', resolve, { once: true }); });
    onText?.('好的。'); return { text: '好的。', toolCalls: [], stop: 'end_turn' };
  } };
  const runner = createTaskRunner({ getConfig: async () => ({ provider: 'mock', models: {}, keys: {}, autoMemory: false }), makeAdapter: () => ({ adapter, model: 'fixture' }), makeTools: () => [], maxRunning: 1, userAccess: { current: currentUser, run: runAsUser, active: security.users.active } });
  const waitCalls = async n => { for (let i = 0; calls.length < n && i < 200; i++) await new Promise(r => setTimeout(r, 5)); expect(calls.length).toBe(n); };
  try {
    await runAsUser(a.id, () => runner.start({ text: '你好' }));
    const second = await runAsUser(a.id, () => runner.start({ text: '谢谢' }));
    await runAsUser(b.id, () => runner.start({ text: '你好' }));
    expect(runAsUser(b.id, () => runner.stop(second.id))).toBe(false);
    await waitCalls(1); resumes[0]();
    await waitCalls(2); expect(calls[1]).toBe(b.id); resumes[1]();
    await waitCalls(3); expect(calls[2]).toBe(a.id); resumes[2]();
    await runner.settled();
  } finally { runner.stopUser(a.id); runner.stopUser(b.id); for (const resume of resumes) resume(); await runner.settled(); }
});

it('重启后各人的提醒只写回自己的会话和通知，同一次不重复跑', async () => {
  const { a, b } = accounts();
  useBackend(createUserStore(dir));
  let clock = Date.now();
  for (const user of [a, b]) await runAsUser(user.id, async () => {
    const s = await scheduler.upsert({ title: user.name + '的提醒', prompt: '提醒用户喝水', kind: 'interval', everyMinutes: 5 });
    clock = Math.max(clock, s.nextRun + 1000);
  });
  // 重建文件后端，模拟进程重启丢失所有内存缓存。
  useBackend(createUserStore(dir));
  const started = [];
  const runner = {
    async start({ sessionId, text }) { started.push(currentUser()); await sessions.save({ ...sessions.create(), id: sessionId, messages: [{ role: 'user', content: text }] }); return { id: sessionId }; },
    edit: async (id, fn) => fn(await sessions.get(id)), get: () => ({ status: 'done' }), events: () => [{ type: 'task_state', status: 'done', text: '该喝水了。' }]
  };
  for (const user of [a, b]) await runAsUser(user.id, async () => {
    await createServerSchedules({ runner, now: () => clock, pollMs: 1 }).tick();
    await createServerSchedules({ runner, now: () => clock, pollMs: 1 }).tick();
    expect((await sessions.list()).map(s => s.title)).toEqual(['⏰ ' + user.name + '的提醒']);
    expect(await notices()).toHaveLength(1);
  });
  expect(started).toEqual([a.id, b.id]);
  expect(await sessions.list()).toEqual([]);
});
