import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodeProjectStore } from '../server/codeProjectStore.mjs';
it('项目索引按UTF8字节限制，超限更新不会破坏原绑定', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-store-'));
  try {
    const store = createCodeProjectStore(root);
    await store.update((d) => {
      d.projects.push({ id: 'old', name: '保留项目' });
    });
    await expect(
      store.update((d) => {
        d.projects.push({ id: 'too-large', name: '字'.repeat(100000) });
      })
    ).rejects.toMatchObject({ code: 'CODE_PROJECT_CAPACITY' });
    expect((await store.read()).projects).toEqual([{ id: 'old', name: '保留项目' }]);
    const restored = createCodeProjectStore(root);
    expect((await restored.read()).projects[0].id).toBe('old');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('损坏项目索引不被悄悄清空重建', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-store-bad-'));
  try {
    await fs.writeFile(path.join(root, 'index.json'), '{broken');
    const store = createCodeProjectStore(root);
    await expect(store.read()).rejects.toMatchObject({ code: 'CODE_PROJECT_INDEX' });
    expect(await fs.readFile(path.join(root, 'index.json'), 'utf8')).toBe('{broken');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
