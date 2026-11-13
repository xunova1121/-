import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

let directory, mode, server, base;
const owner = tokenFor('fixture-search-cors-owner');
const api = (route, token = owner, body = {}) => fetch(base + route, {
  method: 'POST', headers: { Origin: 'http://localhost', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-search-cors-'));
  mode = createServerMode({ dataDir: directory, password: 'fixture-search-cors-owner' });
  await mode.ready;
  server = createServer({ serverMode: mode });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => {
  await mode.runner.settled();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  useBackend(null);
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(['http://localhost', 'capacitor://localhost'])('云网关给%s的搜索预检返回必需头，其他模型代理不随之放开', async origin => {
  const headers = { Origin: origin, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,x-jarvis-client,x-jarvis-upstream,x-jarvis-search-key' };
  for (const protocol of ['responses', 'chat-completions']) {
    const response = await fetch(`${base}/api/llm/openai-search/${protocol}`, { method: 'OPTIONS', headers });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST');
    for (const field of headers['Access-Control-Request-Headers'].split(',')) expect(response.headers.get('access-control-allow-headers')).toContain(field);
  }
  for (const route of ['/api/llm/openai/chat/completions', '/api/llm/openai-search/unknown']) {
    const response = await fetch(base + route, { method: 'OPTIONS', headers });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await response.arrayBuffer();
  }
});

it('预检成功不会绕过登录、成员或评测权限；管理员实际请求仍校验独立搜索Key', async () => {
  const member = await (await api('/api/server/users', owner, { name: '搜索审查成员' })).json();
  const login = await (await api('/api/server/login', '', { password: member.accessCode })).json();
  const evaluation = await (await api('/api/server/security/evaluations', owner, { name: '搜索审查评测' })).json();
  expect(login.token).toBeTruthy();
  expect(evaluation.token).toBeTruthy();
  for (const [token, expected] of [['', 401], [login.token, 403], [evaluation.token, 403]]) {
    const response = await api('/api/llm/openai-search/responses', token);
    expect(response.status).toBe(expected);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await response.arrayBuffer();
  }
  const response = await api('/api/llm/openai-search/responses');
  expect(response.status).toBe(400);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect((await response.json()).code).toBe('OPENAI_SEARCH_KEY');
});
