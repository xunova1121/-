import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend, collection } from '../src/agent/store.js';
import { recordWorkAttempt } from '../src/agent/workLedger.js';
import * as workspace from '../src/agent/workspace.js';
it('成果API需要认证，允许手机来源；只能删除成果记录，不误删其他配置', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-ledger-server-'));
  const mode = createServerMode({ dataDir: dir, password: 'test-only-work-ledger' });
  const server = createServer({ serverMode: mode, ollama: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + tokenFor('test-only-work-ledger'), Origin: 'capacitor://localhost' };
  try {
    expect((await fetch(base + '/api/work-records')).status).toBe(401);
    await collection('sessions').put({ id: 'cloud-session', messages: [] });
    await workspace.write('音乐/服务器歌曲.mp3', new Blob(['audio']));
    const record = await recordWorkAttempt({
      tool: 'sing_song',
      args: { title: '服务器歌曲' },
      output: '已经唱好，保存在 音乐/服务器歌曲.mp3',
      ok: true,
      sessionId: 'cloud-session',
      scope: {},
      callId: 'call-song'
    });
    const response = await fetch(base + '/api/work-records?kind=song', { headers });
    expect(response.status).toBe(200);
    // 沿用原服务器凭Bearer令牌、无Cookie的CORS约定，不把回显Origin当认证要求。
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const result = await response.json();
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ id: record.id, sessionId: 'cloud-session', title: '服务器歌曲' });
    const patched = await fetch(base + '/api/work-records/' + encodeURIComponent(record.id), {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '服务器更正歌名' })
    });
    expect(patched.status).toBe(200);
    const corrected = await (await fetch(base + '/api/work-records?path=' + encodeURIComponent('音乐/服务器歌曲.mp3'), { headers })).json();
    expect(corrected.items[0]).toMatchObject({ title: '服务器歌曲', displayTitle: '服务器更正歌名' });
    await collection('kv').put({ id: 'core', human: '保留的用户信息' });
    expect((await fetch(base + '/api/work-records/core', { method: 'DELETE', headers })).status).toBe(200);
    expect((await collection('kv').get('core')).human).toBe('保留的用户信息');
    expect((await fetch(base + '/api/work-records/' + encodeURIComponent(record.id), { method: 'DELETE', headers })).status).toBe(200);
    expect((await (await fetch(base + '/api/work-records', { headers })).json()).total).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    useBackend(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
