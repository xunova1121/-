import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { MockAgent } from '../server/agents.mjs';
import { useBackend } from '../src/agent/store.js';
import { readinessItem } from '../shared/capabilityReadiness.js';

it('实际HTTP统一自检必须鉴权，支持安卓跨域，不返回配置或修改Key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-readiness-http-'));
  const file = path.join(dir, 'config.json');
  const original = JSON.stringify({
    provider: 'custom',
    models: { custom: 'gpt-6.1-sol' },
    baseURLs: { custom: 'https://private.invalid' },
    keys: { custom: 'private-model-key' },
    pixabayKey: 'private-pixabay-key',
    codeRepos: { token: 'private-github-token' }
  });
  await fs.writeFile(file, original);
  const requests = [];
  const mode = createServerMode({
    dataDir: dir,
    password: 'readiness-password',
    readinessRuntime: {
      check: async (options) => {
        requests.push(options);
        return { checkedAt: Date.now(), version: '1.0.377', checks: [readinessItem('office', 'executable')] };
      }
    }
  });
  const server = createServer({ serverMode: mode, agent: new MockAgent(), ollama: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    expect((await fetch(base + '/api/server/readiness', { method: 'POST' })).status).toBe(401);
    expect(requests).toHaveLength(0);
    const cors = await fetch(base + '/api/server/readiness', {
      method: 'OPTIONS',
      headers: { Origin: 'https://localhost', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    expect(cors.status).toBe(204);
    expect(cors.headers.get('access-control-allow-origin')).toBe('*');
    const result = await fetch(base + '/api/server/readiness', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenFor('readiness-password'), 'Content-Type': 'application/json' },
      body: '{}'
    });
    expect(result.status).toBe(200);
    const report = await result.json();
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'server', modelRequested: false, configurationChanged: false });
    expect(report.checks).toHaveLength(16);
    expect(JSON.stringify(report)).not.toContain('private-');
    expect(requests).toEqual([{ probeRuntime: true }]);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mode.ready;
    useBackend(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
