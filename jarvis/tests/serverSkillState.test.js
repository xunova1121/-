import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServer } from '../server/server.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import * as packs from '../src/agent/skillPacks.js';
import { useBackend } from '../src/agent/store.js';

let folder, server, base, client;
const password = 'skill-state-fixture';
beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-state-'));
  const mode = createServerMode({ dataDir: folder, password });
  await mode.ready;
  server = createServer({ serverMode: mode, ollama: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  client = createServerClient({ base, token: tokenFor(password) });
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  useBackend(null);
  await fs.rm(folder, { recursive: true, force: true });
});
it('服务器代码技能停用、刷新预置后仍停用；显式启用才恢复', async () => {
  const response = await fetch(base + '/api/server/skills/code-development', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + tokenFor(password), 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: 'code-development', enabled: false });
  await packs.seedBuiltins();
  expect((await packs.get('code-development')).enabled).toBe(false);
  await client.setSkillEnabled('code-development', true);
  expect((await packs.get('code-development')).enabled).toBe(true);
});
it('启停需鉴权和布尔值，已卸载技能不能靠启用接口重新安装', async () => {
  const url = base + '/api/server/skills/code-development';
  expect((await fetch(url, { method: 'PATCH', body: '{"enabled":false}' })).status).toBe(401);
  await expect(client.setSkillEnabled('code-development', 'false')).rejects.toMatchObject({ status: 400 });
  await client.removeSkill('code-development');
  await expect(client.setSkillEnabled('code-development', true)).rejects.toMatchObject({ status: 404 });
  await packs.seedBuiltins();
  expect(await packs.get('code-development')).toBeFalsy();
});
