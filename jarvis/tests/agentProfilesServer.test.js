import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createUserStore, runAsUser } from '../server/userScope.mjs';
import { useBackend, collection } from '../src/agent/store.js';
import { BUILTIN_AGENTS, createAgentRegistry } from '../src/agent/agentProfiles.js';
import { createServerClient } from '../src/core/serverClient.js';

let dir, server, mode, base, a, b, aLogin, bLogin;
const owner = tokenFor('fixture-profile-owner');
const profile = (id = 'same-id', name = '甲的智能体') => ({ ...structuredClone(BUILTIN_AGENTS[0]), id, name, source: 'user' });
const api = (token, route, method = 'GET', body) => fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const json = async (...args) => { const res = await api(...args); expect(res.ok).toBe(true); return res.json(); };
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-profiles-'));
  mode = createServerMode({ dataDir: dir, password: 'fixture-profile-owner' });
  await mode.ready;
  server = createServer({ serverMode: mode });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  a = await json(owner, '/api/server/users', 'POST', { name: '甲' });
  b = await json(owner, '/api/server/users', 'POST', { name: '乙' });
  aLogin = await json('', '/api/server/login', 'POST', { password: a.accessCode });
  bLogin = await json('', '/api/server/login', 'POST', { password: b.accessCode });
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

it('匿名/评测令牌不能访问，成员不得伪造归属或新建builtin', async () => {
  expect((await api('', '/api/agent-profiles')).status).toBe(401);
  const evaluation = await json(owner, '/api/server/security/evaluations', 'POST', { name: '智能体隔离测试' });
  expect((await api(evaluation.token, '/api/agent-profiles')).status).toBe(403);
  const forged = await api(aLogin.token, '/api/agent-profiles', 'POST', { ...profile('forged'), userId: b.id });
  expect(forged.status).toBe(400);
  expect(await forged.json()).toMatchObject({ field: 'profile' });
  expect((await api(aLogin.token, '/api/agent-profiles', 'POST', { ...profile('forged'), source: 'builtin' })).status).toBe(400);
  expect((await api(aLogin.token, '/api/agent-profiles/ppt-maker', 'DELETE')).status).toBe(409);
  expect((await api(aLogin.token, '/api/agent-profiles', 'PATCH', {})).status).toBe(403);
});

it('同名配置跨成员完全隔离，同一成员两台设备通过真实客户端共享且可更新', async () => {
  await Promise.all([json(aLogin.token, '/api/agent-profiles', 'POST', profile()), json(bLogin.token, '/api/agent-profiles', 'POST', profile('same-id', '乙的智能体'))]);
  const login2 = await json('', '/api/server/login', 'POST', { password: a.accessCode });
  const client = createServerClient({ base, token: login2.token }).agentProfiles;
  expect((await client.getAgent('same-id')).name).toBe('甲的智能体');
  await client.updateAgent('same-id', profile('same-id', '甲的新名字'));
  expect((await json(aLogin.token, '/api/agent-profiles/same-id')).name).toBe('甲的新名字');
  expect((await json(bLogin.token, '/api/agent-profiles/same-id')).name).toBe('乙的智能体');
  expect((await api(owner, '/api/agent-profiles/same-id')).status).toBe(404);
  expect((await client.listAgents({ category: 'mine', query: '新名字' })).map(p => p.id)).toEqual(['same-id']);
  await client.createAgent(profile('only-a', '甲独有'));
  expect((await api(bLogin.token, '/api/agent-profiles/only-a', 'PUT', profile('only-a'))).status).toBe(404);
  expect((await api(bLogin.token, '/api/agent-profiles/only-a', 'DELETE')).status).toBe(404);
  await client.removeAgent('only-a');
  expect(await client.getAgent('only-a')).toBeNull();
});

it('配置真实写盘，重建存储后可读，原对话/kv不变', async () => {
  await runAsUser(a.id, async () => {
    await collection('kv').put({ id: 'old-marker', value: '原数据' });
    await collection('sessions').put({ id: 'old-session', messages: [], title: '旧对话' });
  });
  const disk = createUserStore(dir);
  const registry = createAgentRegistry({ bind: () => {
    const scope = disk.scoped();
    return { scopeKey: scope, get: id => scope.get('kv', id), put: value => scope.put('kv', value) };
  } });
  expect((await runAsUser(a.id, () => registry.getAgent('same-id'))).name).toBe('甲的新名字');
  expect((await runAsUser(b.id, () => registry.getAgent('same-id'))).name).toBe('乙的智能体');
  await runAsUser(a.id, () => registry.updateAgent('same-id', profile('same-id', '重新打开后修改')));
  expect(await runAsUser(a.id, () => disk.get('kv', 'old-marker'))).toMatchObject({ value: '原数据' });
  expect(await runAsUser(a.id, () => disk.get('sessions', 'old-session'))).toMatchObject({ title: '旧对话' });
});

it('错误字段可见但不含密钥值，错误读写不改变现有配置，停用成员失去访问', async () => {
  const before = await json(bLogin.token, '/api/agent-profiles/same-id');
  const invalid = await api(bLogin.token, '/api/agent-profiles/same-id', 'PUT', { ...profile(), keys: { openrouter: 'fixture-secret-do-not-echo' } });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain('fixture-secret-do-not-echo');
  expect(await json(bLogin.token, '/api/agent-profiles/same-id')).toEqual(before);
  await json(owner, '/api/server/users/' + b.id, 'PATCH', { action: 'disable' });
  expect((await api(bLogin.token, '/api/agent-profiles')).status).toBe(401);
});
