import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { createServerClient, followTask } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';

it('同一任务在模型输出结束前可经普通 SSE 和整包原生网络读到首段，旧服务器仍交付完整正文', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weiyang-event-batch-'));
  const password = 'event-batch-test';
  let finishAnswer;
  const pause = new Promise(resolve => { finishAnswer = resolve; });
  const adapter = { kind: 'mock', async stream({ onText }) {
    onText('第一段。');
    await pause;
    onText('第二段。');
    return { text: '第一段。第二段。', toolCalls: [], stop: 'end_turn' };
  } };
  const mode = createServerMode({ dataDir: dir, password, makeTaskAdapter: () => ({ model: 'fixture', adapter }) });
  const server = createServer({ serverMode: mode, ollama: null });
  let observers = [];
  const stop = new AbortController();
  try {
    await mode.ready;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const login = await fetch(base + '/api/server/login', { method: 'POST', body: JSON.stringify({ password }) });
    const { token } = await login.json();
    const transports = ['stream', 'buffer', 'old-server'];
    const clients = transports.map(transport => createServerClient({ base, token, fetchImpl: async (url, init) => {
      const res = await fetch(transport === 'old-server' ? url.replace('&batch=1', '') : url, init);
      if (transport === 'stream' || !url.includes('/events?')) return res;
      // 旧手机或代理在 EOF 才交出整个响应体。
      return new Response(await res.text(), { headers: res.headers, status: res.status });
    } }));
    clients[1].streamFailed();
    clients[2].streamFailed();
    const { id } = await clients[0].startTask({ text: '你好' });
    const texts = ['', '', ''];
    const counts = new Map();
    observers = clients.map((client, index) => followTask(client, id, { signal: stop.signal, onEvent(event) {
      if (event.type === 'text') texts[index] += event.delta;
      if (event.type === 'server_connection') counts.set(index, event.state);
    } }));
    await vi.waitFor(() => expect(texts).toEqual(['第一段。', '第一段。', '']), { timeout: 4000 });
    // 从最新序号回到前台时还没有新字，健康的流仍立即确认连接。
    const { seq } = await clients[0].getTask(id);
    const resumed = await fetch(`${base}/api/tasks/${id}/events?after=${seq}`, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2500)
    });
    const reader = resumed.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
    await reader.cancel();
    finishAnswer();
    expect((await Promise.all(observers)).map(event => event.status)).toEqual(['done', 'done', 'done']);
    expect(texts).toEqual(transports.map(() => '第一段。第二段。'));
    expect(counts.size).toBe(0);
  } finally {
    finishAnswer();
    stop.abort();
    await Promise.allSettled(observers);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    useBackend(null);
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
