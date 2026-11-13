import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dependencyPlan, downloadDependencies } from '../server/codeDependencies.mjs';
const bytes = Buffer.from('fictional npm archive');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const pkg = { name: 'demo', version: '1.0.0', dependencies: { example: '1.0.0' } };
const lock = () => ({
  lockfileVersion: 3,
  packages: { '': pkg, 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity } }
});
it('无依赖可生成临时锁；有依赖必须锁定，拒绝Git/本地链接/非允许源/无完整性', () => {
  expect(dependencyPlan({ name: 'plain' }, null).downloads).toEqual([]);
  expect(() => dependencyPlan(pkg, null)).toThrow();
  for (const resolved of ['git+https://github.com/a/b', 'file:/etc/passwd', 'https://evil.invalid/x.tgz', 'http://registry.npmjs.org/x.tgz']) {
    const value = lock();
    value.packages['node_modules/example'].resolved = resolved;
    expect(() => dependencyPlan(pkg, value)).toThrow();
  }
  for (const change of [{ link: true }, { integrity: '' }]) {
    const value = lock();
    Object.assign(value.packages['node_modules/example'], change);
    expect(() => dependencyPlan(pkg, value)).toThrow();
  }
  expect(() => dependencyPlan({ workspaces: ['packages/*'] }, lock())).toThrow();
  const source = lock(),
    plan = dependencyPlan(pkg, source);
  expect(plan.downloads[0].url).toBe('https://registry.npmmirror.com/example/-/example-1.0.0.tgz');
  expect(plan.lock.packages['node_modules/example'].resolved).toMatch(/^file:\/packages\//);
  expect(source.packages['node_modules/example'].resolved).toContain('https:');
});
it('只向允许源发GET、先扣预算，验证完整性后写本地，拒绝出站重定向/破损包', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-dep-'));
  try {
    const plan = dependencyPlan(pkg, lock()),
      order = [];
    const fetchImpl = vi.fn(async (url, init) => {
      order.push('fetch');
      expect(init.redirect).toBe('manual');
      expect(init.headers.Authorization).toBeUndefined();
      return new Response(bytes);
    });
    expect(
      await downloadDependencies(plan, dir, {
        fetchImpl,
        retrieval: {
          consume() {
            order.push('budget');
          }
        }
      })
    ).toMatchObject({ packages: 1, downloadedBytes: bytes.length });
    expect(order).toEqual(['budget', 'fetch']);
    expect(await fs.readFile(path.join(dir, plan.downloads[0].id))).toEqual(bytes);
    const redirect = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.invalid/x.tgz' } }));
    await expect(downloadDependencies(plan, dir, { fetchImpl: redirect })).rejects.toMatchObject({ code: 'CODE_DEP_REDIRECT' });
    expect(redirect).toHaveBeenCalledTimes(1);
    await expect(downloadDependencies(plan, dir, { fetchImpl: async () => new Response('damaged') })).rejects.toMatchObject({ code: 'CODE_DEP_INTEGRITY' });
    const budget = vi.fn(() => {
      throw Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
    });
    const blocked = vi.fn();
    await expect(downloadDependencies(plan, dir, { fetchImpl: blocked, retrieval: { consume: budget } })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(blocked).not.toHaveBeenCalled();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
