import { it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { codeError } from '../server/codeGit.mjs';

let dir, server, base;
const pass = 'test-code-repo-password';
const secret = 'ghp_' + 'OnlyTestCredential'.repeat(3);
const hosting = {
  async repository(value) {
    if (value.token === 'rejected_token_1234567890') throw codeError('CODE_GITHUB_AUTH', 'GitHub令牌无效或已过期', { upstreamStatus: 401 });
    return { repository: value.repository, defaultBranch: 'main' };
  }
};
const api = (route, method = 'GET', body) =>
  fetch(base + route, {
    method,
    headers: { Authorization: 'Bearer ' + tokenFor(pass), 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) })
  });
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-repo-api-'));
  const mode = createServerMode({ dataDir: dir, password: pass, codeHosting: hosting });
  await mode.ready;
  server = createServer({ serverMode: mode, ollama: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
it('仓库设置独立鉴权，0600存盘，配置读回及通用更新不能泄漏/覆写令牌', async () => {
  expect((await fetch(base + '/api/server/code-repos')).status).toBe(401);
  await api('/api/server/config', 'PUT', { provider: 'mock', keys: { mock: 'original-model-key' }, customSetting: 'preserved' });
  fs.writeFileSync(path.join(dir, 'config.json.tmp'), '{}', { mode: 0o644 });
  const response = await api('/api/server/code-repos', 'PUT', { provider: 'github', repository: 'Demo/Sandbox', token: secret });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    connected: true,
    tokenConfigured: true,
    repository: 'demo/sandbox',
    defaultBranch: 'main',
    protectDefaultBranch: true
  });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  expect(disk.codeRepos.token).toBe(secret);
  expect(disk.keys.mock).toBe('original-model-key');
  expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600);
  expect(await (await api('/api/server/config')).text()).not.toContain(secret);
  expect(await (await api('/api/server/code-repos')).text()).not.toContain(secret);
  await api('/api/server/config', 'PUT', { codeRepos: { token: 'evil', repository: 'evil/repo' }, customSetting: 'updated' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).codeRepos).toEqual(disk.codeRepos);
  expect((await api('/api/server/code-repos', 'PUT', { repository: 'demo/sandbox', token: '' })).status).toBe(200);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).codeRepos.token).toBe(secret);
});
it('上游鉴权失败不冒充服务器登录过期，保存失败保留旧配置，断开不删工作副本', async () => {
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const invalid = await api('/api/server/code-repos', 'PUT', { repository: 'demo/sandbox', token: 'rejected_token_1234567890' });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ code: 'CODE_GITHUB_AUTH', upstreamStatus: 401 });
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  for (const input of [{ provider: 'gitlab', repository: 'a/b' }, { repository: '../repo' }, { repository: 'demo/sandbox', protectDefaultBranch: false }]) {
    expect((await api('/api/server/code-repos', 'PUT', input)).status).toBe(400);
  }
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'repos/keep.txt'), 'existing work');
  expect(await (await api('/api/server/code-repos', 'DELETE')).json()).toMatchObject({ connected: false, tokenConfigured: false });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  expect(disk.codeRepos).toBeUndefined();
  expect(disk.customSetting).toBe('updated');
  expect(disk.keys.mock).toBe('original-model-key');
  expect(fs.readFileSync(path.join(dir, 'repos/keep.txt'), 'utf8')).toBe('existing work');
});
