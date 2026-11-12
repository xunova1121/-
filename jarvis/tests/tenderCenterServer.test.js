import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';
import { businessDay } from '../src/agent/businessSources.js';
let dir, server, mode, base, a, b, ac, bc, records = [];
const ownerToken = tokenFor('fixture-tender-owner');
const api = (token, route, method = 'GET', body) => fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
const json = async (...args) => { const r = await api(...args); expect(r.status).toBe(200); return r.json(); };
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-http-'));
  mode = createServerMode({ dataDir: dir, password: 'fixture-tender-owner', tenderCollector: { listing: async () => ({ rows: records }), detail: async () => ({ budgetText: '200万元', detailAt: Date.now() }) } });
  await mode.ready;
  server = createServer({ serverMode: mode }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  const al = await json(ownerToken, '/api/server/users', 'POST', { name: '甲' });
  const bl = await json(ownerToken, '/api/server/users', 'POST', { name: '乙' });
  a = await json('', '/api/server/login', 'POST', { password: al.accessCode });
  b = await json('', '/api/server/login', 'POST', { password: bl.accessCode });
  ac = createServerClient({ base, token: a.token }); bc = createServerClient({ base, token: b.token });
});
afterAll(async () => { await mode?.tenders.stop(); await mode?.runner.settled(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });
it('浏览器客户端经真实HTTP保存本人订阅，后台刷新不创建任务，另一成员看不到私人提醒', async () => {
  await ac.tenders.change({ action: 'subscribe', name: '甲的农业', filters: { query: '农业' }, userId: 'owner' });
  records = [{ title: '江苏农业设备招标', region: '江苏', type: 'tender', publishedAt: businessDay(), url: 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/test.htm' }];
  await mode.tenders.refresh();
  expect((await ac.tenders.list()).total).toBe(1); expect((await bc.tenders.list()).total).toBe(1);
  expect((await ac.tenders.mine()).alerts).toHaveLength(1);
  expect((await bc.tenders.mine()).subscriptions).toHaveLength(0);
  expect((await bc.notices()).some(row => row.kind === 'tender')).toBe(false);
  expect((await ac.notices()).filter(row => row.kind === 'tender')).toHaveLength(1);
  expect(mode.runner.list()).toHaveLength(0);
  expect((await ac.listSessions())).toHaveLength(0);
});
it('成员可筛选与收藏但不能停全局采集、刷新或访问其他账号订阅', async () => {
  const result = await ac.tenders.list({ query: '农业', minBudget: 1e6 });
  expect(result.canManage).toBe(false); expect(result.total).toBe(1);
  await ac.tenders.change({ action: 'favorite', id: result.items[0].id, owner: 'owner' });
  expect((await bc.tenders.list({ favorites: 'true' })).total).toBe(0);
  await expect(ac.tenders.configure(false)).rejects.toMatchObject({ status: 403 });
  await expect(bc.tenders.refresh()).rejects.toMatchObject({ status: 403 });
  const sub = (await ac.tenders.mine()).subscriptions[0];
  await expect(bc.tenders.change({ action: 'subscribe', id: sub.id })).rejects.toMatchObject({ status: 404 });
  expect((await api(a.token, '/api/tenders/anything')).status).toBe(403);
});
it('匿名和评测令牌不能读写订阅，GET不触发采集，管理员可暂停/恢复', async () => {
  const ev = await json(ownerToken, '/api/server/security/evaluations', 'POST', { name: '订阅隔离验收' });
  expect((await api('', '/api/tenders/catalog')).status).toBe(401);
  for (const route of ['/api/tenders/catalog', '/api/tenders/mine', '/api/tenders/settings', '/api/tenders/refresh']) {
    expect((await api(ev.token, route)).status).toBe(403);
  }
  const owner = createServerClient({ base, token: ownerToken });
  await owner.tenders.configure(false); expect((await owner.tenders.list()).enabled).toBe(false);
  await owner.tenders.configure(true); expect((await owner.tenders.list()).enabled).toBe(true);
  await expect(owner.tenders.refresh()).rejects.toMatchObject({ status: 429 });
});
