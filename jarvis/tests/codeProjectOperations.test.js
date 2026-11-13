import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodeProjects } from '../server/codeProjects.mjs';
it('项目建仓确认与账号切换互斥，验证期间不会创建仓库', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-account-'));
  let unblock,
    created = 0;
  const cfg = { codeAccount: { login: 'demo', token: 'x'.repeat(32), verifiedAt: 'fixture' } };
  const p = createCodeProjects({
    dataDir: root,
    getConfig: () => cfg,
    saveConfig: (v) => Object.assign(cfg, v),
    legacyRepos: { abortAll() {} },
    github: {
      account: () =>
        new Promise((r) => {
          unblock = r;
        }),
      create: () => {
        created++;
      }
    }
  });
  try {
    const request = await p.prepare({ name: 'example' }, 'session');
    const changing = p.saveAccount({ token: 'y'.repeat(32) });
    await expect(p.execute(request.id, 'session')).rejects.toMatchObject({ code: 'CODE_PROJECT_BUSY' });
    expect(created).toBe(0);
    unblock({ login: 'other' });
    await changing;
    await expect(p.prepare({ name: 'bad name' }, 'session')).rejects.toMatchObject({ code: 'CODE_PROJECT_NAME' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('服务器重启留下creating状态时，确认只报告待核对，不再次建仓', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-interrupted-'));
  let calls = 0;
  try {
    const { createCodeProjectStore } = await import('../server/codeProjectStore.mjs');
    const store = createCodeProjectStore(path.join(root, 'code-projects'));
    await store.update((d) => {
      d.requests.push({ id: 'r', sessionId: 's', kind: 'create', status: 'creating', expiresAt: Date.now() + 100000 });
    });
    const p = createCodeProjects({
      dataDir: root,
      getConfig: () => ({}),
      github: {
        create: () => {
          calls++;
        }
      }
    });
    await expect(p.execute('r', 's')).rejects.toMatchObject({ code: 'CODE_PROJECT_UNCERTAIN' });
    expect(calls).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
