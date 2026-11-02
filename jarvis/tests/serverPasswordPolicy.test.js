/** 用户2026-11-02明确将最低长度改为6位，长密码和既有登录兼容。 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerMode } from '../server/serverMode.mjs';
import { createServer } from '../server/server.mjs';
import { useBackend } from '../src/agent/store.js';

const folders = [];
afterEach(() => {
  useBackend(null);
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
const directory = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-password-policy-'));
  folders.push(folder);
  return folder;
};

describe('主密码最低6位', () => {
  it.each(['', 'a', '12345'])('不足6位拒绝启动，不写入密码', (password) => {
    const dataDir = directory();
    expect(() => createServerMode({ dataDir, password })).toThrow(/至少 6 位/);
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
  it.each(['123456', 'aB3x9z', 'long-fixture-password-2026'])('6位数字、6位混合与长密码均可实际登录，密码不落配置', async (password) => {
    const dataDir = directory();
    const mode = createServerMode({ dataDir, password });
    await mode.ready;
    const server = createServer({ serverMode: mode, ollama: null });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const login = await fetch(base + '/api/server/login', { method: 'POST', body: JSON.stringify({ password }) });
      expect(login.status).toBe(200);
      const { token } = await login.json();
      expect(typeof token).toBe('string');
      expect((await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(200);
      expect(fs.existsSync(path.join(dataDir, 'config.json'))).toBe(false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
  it('安装校验与实际服务要求一致，已有env文件不改写', () => {
    const install = fs.readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
    expect(install).toContain('${#P1} -ge 6');
    expect(install).toContain('至少 6 位');
    expect(install).toMatch(/if \[\[ ! -f "\$ENVF" \]\]; then[\s\S]*访问密码/);
    expect(install).not.toContain('${#P1} -ge 8');
  });
});
