import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

let dir, mode, server, local, base, localBase, member, evaluation;
const owner = tokenFor('fixture-cross-origin-owner');
const id = '11111111-1111-4111-8111-111111111111';
const routes = [
  ['/api/agent-profiles', 'GET,POST'], ['/api/agent-profiles/test-agent', 'GET,PUT,DELETE'],
  ['/api/studio/preferences', 'GET,PATCH'], ['/api/studio/works', 'GET'], ['/api/studio/versions?path=test.docx', 'GET'],
  ...['copy', 'edit', 'inspect', 'preview'].map(name => ['/api/studio/' + name, 'POST']),
  ['/api/studio/team', 'GET,POST'], ['/api/studio/team/' + id, 'DELETE'], ['/api/studio/team/' + id + '/copy', 'POST'],
  ['/api/tenders/catalog?query=农业', 'GET'], ['/api/tenders/mine', 'GET,PATCH'],
  ['/api/tenders/settings', 'PATCH'], ['/api/tenders/refresh', 'POST']
];
const request = (route, token, body) => fetch(base + route, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  ...(body !== undefined && { body: JSON.stringify(body) })
});
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cors-'));
  mode = createServerMode({ dataDir: dir, password: 'fixture-cross-origin-owner', tenderCollector: { listing: async () => ({ rows: [] }), detail: async () => ({}) } });
  await mode.ready;
  server = createServer({ serverMode: mode }); local = createServer();
  for (const app of [server, local]) await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port; localBase = 'http://127.0.0.1:' + local.address().port;
  const user = await (await request('/api/server/users', owner, { name: '跨域成员' })).json();
  member = (await (await request('/api/server/login', '', { password: user.accessCode })).json()).token;
  evaluation = (await (await request('/api/server/security/evaluations', owner, { name: '跨域评测隔离' })).json()).token;
});
afterAll(async () => {
  await mode?.tenders.stop(); await mode?.runner.settled();
  for (const app of [server, local]) { app?.closeAllConnections(); if (app) await new Promise(resolve => app.close(resolve)); }
  useBackend(null); fs.rmSync(dir, { recursive: true, force: true });
});

it.each(['http://127.0.0.1:18787', 'https://localhost', 'null'])('%s可预检全部智能体资源操作，预检不执行读写', async origin => {
  for (const [route, methods] of routes) for (const method of methods.split(',')) {
    const r = await fetch(base + route, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(r.status, route).toBe(204);
    expect(r.headers.get('access-control-allow-origin'), route).toBe('*');
    expect(r.headers.get('access-control-allow-methods'), route).toContain(method);
    expect(r.headers.get('access-control-allow-headers'), route).toContain('authorization');
    expect(r.headers.get('access-control-allow-headers'), route).toContain('content-type');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  }
  expect(mode.runner.list()).toHaveLength(0);
  expect((await (await request('/api/agent-profiles', member)).json()).every(p => p.source === 'builtin')).toBe(true);
});

it('跨域响应可读取，但匿名/评测/成员管理权限仍拒绝', async () => {
  const origin = 'http://127.0.0.1:18787';
  for (const route of ['/api/agent-profiles', '/api/studio/preferences', '/api/tenders/mine']) {
    for (const [token, status] of [['', 401], [evaluation, 403], [member, 200]]) {
      const r = await fetch(base + route, { headers: { Origin: origin, ...(token && { Authorization: 'Bearer ' + token }) } });
      expect(r.status, route).toBe(status);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
    }
  }
  const denied = await fetch(base + '/api/tenders/settings', { method: 'PATCH', headers: { Origin: origin, Authorization: 'Bearer ' + member, 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
  expect(denied.status).toBe(403); expect(denied.headers.get('access-control-allow-origin')).toBe('*');
});

it('不扩大为任意API跨域，不给本机网关开放这些接口', async () => {
  for (const route of ['/api/fetch', '/api/mcp', '/api/llm/openai/models', '/api/agent-profiles-extra', '/api/agent-profiles/test-agent/admin', '/api/studio/secrets', '/api/tenders/catalog/private']) {
    const r = await fetch(base + route, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'GET' } });
    expect(r.headers.get('access-control-allow-origin'), route).toBeNull();
  }
  for (const [route] of routes) {
    const r = await fetch(localBase + route, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } });
    expect(r.headers.get('access-control-allow-origin'), route).toBeNull();
  }
});
