import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import { runAsUser } from '../server/userScope.mjs';
let dir, server, mode, base, a, b, aLogin, bLogin;
const ownerToken = tokenFor('fixture-owner-password');
const api = (token, route, method = 'GET', body) => fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const json = async (...args) => { const r = await api(...args); expect(r.status).toBe(200); return r.json(); };
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-multi-http-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'mock', autoMemory: false, keys: { openrouter: 'fixture-owner-key-never-expose' }, codeAccount: { token: 'fixture-github-never-expose', login: 'owner-git' } }));
  mode = createServerMode({ dataDir: dir, password: 'fixture-owner-password' });
  await mode.ready;
  server = createServer({ serverMode: mode });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  a = await json(ownerToken, '/api/server/users', 'POST', { name: '甲' });
  b = await json(ownerToken, '/api/server/users', 'POST', { name: '乙' });
  aLogin = await json('', '/api/server/login', 'POST', { password: a.accessCode });
  bLogin = await json('', '/api/server/login', 'POST', { password: b.accessCode });
});
afterAll(async () => { await mode?.runner.settled(); server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

it('成员共享模型但看不到密钥和管理员项目账户，所有管理/代理绕路均被拒绝', async () => {
  const cfg = await json(aLogin.token, '/api/server/config');
  expect(cfg).toMatchObject({ provider: 'mock', readOnly: true, keys: {} });
  expect(JSON.stringify(cfg)).not.toMatch(/fixture-owner-key|fixture-github|owner-git/);
  for (const [route, method] of [['/api/server/config', 'PUT'], ['/api/server/update', 'POST'], ['/api/server/users', 'POST'], ['/api/server/security/evaluations', 'POST'], ['/api/proxy/openai/chat/completions', 'POST'], ['/api/execute', 'POST']]) {
    expect((await api(aLogin.token, route, method, { userId: 'owner', role: 'owner', name: '越权' })).status).toBe(403);
  }
  expect((await json(aLogin.token, '/api/server/status')).identity).toMatchObject({ userId: a.id, role: 'member' });
  const second = await json('', '/api/server/login', 'POST', { password: a.accessCode });
  expect(second.userId).toBe(a.id);
  expect((await json(second.token, '/api/server/security')).devices).toHaveLength(2);
  expect((await json(bLogin.token, '/api/server/security')).devices).toHaveLength(1);
});

it('附件路径相同也各读各的，任务、进度、票据及会话ID不能跨用户访问', async () => {
  for (const [login, label] of [[aLogin, '甲附件'], [bLogin, '乙附件']]) {
    expect((await fetch(base + '/api/files/raw?path=inputs/same.txt', { method: 'PUT', headers: { Authorization: 'Bearer ' + login.token }, body: label })).status).toBe(200);
  }
  expect(await (await api(aLogin.token, '/api/files/raw?path=inputs/same.txt')).text()).toBe('甲附件');
  expect(await (await api(bLogin.token, '/api/files/raw?path=inputs/same.txt')).text()).toBe('乙附件');
  expect((await api(ownerToken, '/api/files/raw?path=inputs/same.txt')).status).toBe(404);
  const ticket = await json(aLogin.token, '/api/server/security/tickets', 'POST', { resource: '/api/files/raw?path=inputs/same.txt' });
  expect(await (await fetch(base + '/api/files/raw?path=inputs/same.txt&ticket=' + ticket.ticket)).text()).toBe('甲附件');
  const task = await json(aLogin.token, '/api/tasks', 'POST', { text: '你好', userId: b.id });
  await mode.runner.settled();
  expect((await json(aLogin.token, '/api/sessions')).some(row => row.id === task.sessionId)).toBe(true);
  expect((await json(bLogin.token, '/api/sessions')).some(row => row.id === task.sessionId)).toBe(false);
  expect((await api(bLogin.token, '/api/sessions/' + task.sessionId)).status).toBe(404);
  expect((await api(bLogin.token, '/api/tasks/' + task.id)).status).toBe(404);
  expect((await api(bLogin.token, '/api/tasks/' + task.id + '/events')).status).toBe(404);
  expect((await json(bLogin.token, '/api/tasks/' + task.id + '/stop', 'POST', {})).ok).toBe(false);
  expect((await json(ownerToken, '/api/sessions')).some(row => row.id === task.sessionId)).toBe(false);
});

it('项目和提醒保存在成员目录，停用用户不删除原数据，其他成员正常使用', async () => {
  await runAsUser(a.id, () => collection('kv').put({ id: 'private-marker', value: '甲' }));
  const session = await json(aLogin.token, '/api/tasks', 'POST', { text: '你好' });
  await mode.runner.settled();
  const projects = await json(aLogin.token, '/api/server/code-projects?session=' + session.sessionId);
  expect(JSON.stringify(projects)).not.toContain('owner-git');
  const ownerBytes = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  await json(ownerToken, '/api/server/users/' + a.id, 'PATCH', { action: 'disable' });
  expect((await api(aLogin.token, '/api/sessions')).status).toBe(401);
  expect((await api(bLogin.token, '/api/sessions')).status).toBe(200);
  expect(await runAsUser(a.id, () => collection('kv').get('private-marker'))).toMatchObject({ value: '甲' });
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(ownerBytes);
});
