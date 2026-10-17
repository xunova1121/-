import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor, maskConfig, mergeConfig } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

let dir, server, base, mode;
const PASS = 'test-password-123';
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-srv-'));
  mode = createServerMode({ dataDir: dir, password: PASS });
  server = createServer({ serverMode: mode, ollama: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });

const auth = { Authorization: `Bearer ${tokenFor(PASS)}` };
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { ...auth, ...(init.body && typeof init.body === 'string' && { 'Content-Type': 'application/json' }), ...init.headers } });

/** 读 SSE：收集事件直到连接结束 */
async function readSse(res) {
  const text = await res.text();
  return text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
}

describe('服务器模式接口', () => {
  it('没登录一律拒绝；密码错了不给令牌，对了给', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/llm/openai/models`)).status).toBe(401); // 模型转发也要登录
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const bad = await fetch(`${base}/api/server/login`, { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
    expect(bad.status).toBe(401);
    const ok = await (await fetch(`${base}/api/server/login`, { method: 'POST', body: JSON.stringify({ password: PASS }) })).json();
    expect(ok.token).toBe(tokenFor(PASS));
  });

  it('发任务 → 关掉连接 → 重新连上补发进度 → 结果在对话里；文件能上传下载', async () => {
    const put = await api(`/api/files/raw?path=${encodeURIComponent('资料/原文.txt')}`, { method: 'PUT', body: '三季度营收 1860 万' });
    expect(put.status).toBe(200);
    const { id, sessionId } = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify({ text: '你好' }) })).json();
    // 只连一下就断开（模拟手机切走），任务照样做完
    const ctrl = new AbortController();
    await api(`/api/tasks/${id}/events`, { signal: ctrl.signal }).catch(() => {});
    ctrl.abort();
    const t0 = Date.now();
    while ((await (await api(`/api/tasks/${id}`)).json()).status !== 'done') { if (Date.now() - t0 > 10000) throw new Error('超时'); await new Promise((r) => setTimeout(r, 50)); }
    const events = await readSse(await api(`/api/tasks/${id}/events?after=0`));
    expect(events.at(-1)).toMatchObject({ type: 'task_state', status: 'done' });
    const tail = await readSse(await api(`/api/tasks/${id}/events?after=${events.at(-2).seq}`));
    expect(tail).toHaveLength(1);
    const list = await (await api('/api/sessions')).json();
    expect(list[0]).toMatchObject({ id: sessionId, count: 2, taskId: null });
    expect(list[0].messages).toBeUndefined();
    const one = await (await api(`/api/sessions/${sessionId}`)).json();
    expect(one.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const files = await (await api('/api/files')).json();
    expect(files.map((f) => f.path)).toContain('资料/原文.txt');
    const raw = await api(`/api/files/raw?path=${encodeURIComponent('资料/原文.txt')}`);
    expect(await raw.text()).toBe('三季度营收 1860 万');
    expect(raw.headers.get('content-disposition')).toContain(encodeURIComponent('原文.txt'));
  });

  it('模型设置：密钥只显示后 4 位，保存时没改的密钥沿用', async () => {
    await api('/api/server/config', { method: 'PUT', body: JSON.stringify({ provider: 'deepseek', keys: { deepseek: 'sk-abcdef123456' } }) });
    const got = await (await api('/api/server/config')).json();
    expect(got.keys.deepseek).toBe('••••3456');
    await api('/api/server/config', { method: 'PUT', body: JSON.stringify({ ...got, models: { deepseek: 'deepseek-chat' } }) });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.keys.deepseek).toBe('sk-abcdef123456');
    expect(saved.models.deepseek).toBe('deepseek-chat');
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o077).toBe(0); // 只有运行未央的账号能读
    expect(maskConfig({ keys: {} }).tavilyKey).toBe('');
    expect(mergeConfig({ keys: { a: 'x' } }, { keys: { a: '' } }).keys.a).toBe('x');
  });

  it('密码太短不让开启', () => {
    expect(() => createServerMode({ dataDir: dir, password: '123' })).toThrow(/至少 8 位/);
  });
});
