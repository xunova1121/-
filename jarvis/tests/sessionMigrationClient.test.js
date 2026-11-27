import { afterEach, expect, it, vi } from 'vitest';
import { createServerClient, saveServerSettings, loadServerSettings } from '../src/core/serverClient.js';

afterEach(() => vi.unstubAllGlobals());

it('旧凭证换发合并并发请求；取消业务等待不取消换发或丢掉已签发凭证', async () => {
  const items = new Map();
  vi.stubGlobal('localStorage', { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) });
  const base = 'https://migration-fixture.invalid', old = 'a'.repeat(64), fresh = 'B'.repeat(43);
  saveServerSettings({ url: base, token: old, enabled: true });
  let release, migrationSignal;
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.endsWith('/api/server/auth/migrate')) {
      migrationSignal = options.signal;
      return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ token: fresh }))); });
    }
    expect(options.headers.Authorization).toBe('Bearer ' + fresh);
    return new Response(JSON.stringify({ tasks: [], provider: 'mock' }));
  });
  const client = createServerClient({ base, token: old, fetchImpl });
  const ctrl = new AbortController();
  const first = client.status(ctrl.signal);
  const second = client.getConfig();
  await Promise.resolve();
  ctrl.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(migrationSignal.aborted).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  release();
  await second;
  expect(loadServerSettings().token).toBe(fresh);
  await client.status();
  expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith('/api/server/auth/migrate'))).toHaveLength(1);
});
