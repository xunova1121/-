import { describe, it, expect, vi } from 'vitest';
import { onServerResume } from '../src/core/serverResume.js';
import { followTask, createServerClient, QUICK_READ_MS, saveServerSettings, loadServerSettings } from '../src/core/serverClient.js';
import { nativeFetcher } from '../src/mobile/nativeFetch.js';

const foreground = (target, active) => { target.__jarvisForeground = active; target.dispatchEvent(Object.assign(new Event('jarvis:foreground'), { detail: { active } })); };
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const done = { seq: 2, type: 'task_state', status: 'done', text: '已完成' };
const until = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 2)); expect(predicate()).toBeTruthy(); };

describe('前台和网络恢复入口', () => {
  it('原生/可见性/焦点同一轮只恢复一次，隐藏时不保活，原生前台不等WebView补发', () => {
    const target = new EventTarget(), doc = new EventTarget(), wake = vi.fn();
    let at = 1000;
    const off = onServerResume(wake, { target, doc, now: () => at });
    doc.hidden = true;
    foreground(target, false); target.dispatchEvent(new Event('focus')); target.dispatchEvent(new Event('online'));
    expect(wake).not.toHaveBeenCalled();
    foreground(target, true); // Android原生先到，此时document.hidden还没更新。
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); target.dispatchEvent(new Event('focus'));
    expect(wake).toHaveBeenCalledTimes(1);
    at += 1000; foreground(target, false); foreground(target, true);
    expect(wake).toHaveBeenCalledTimes(2);
    off(); at += 1000; foreground(target, true); target.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('紧随前台到达的网络恢复能立刻再试，重复online仍合并', () => {
    const target = new EventTarget(), wake = vi.fn();
    const off = onServerResume(wake, { target });
    foreground(target, true); target.dispatchEvent(new Event('online')); target.dispatchEvent(new Event('online'));
    expect(wake.mock.calls.map(([e]) => e.reason)).toEqual(['foreground', 'online']); off();
  });
});

describe('恢复同一任务而不重做', () => {
  it('返回前台直接续接已收到的序号，忽略重复事件，不等45秒也不误降级', async () => {
    let wake, firstSignal;
    const unsubscribe = vi.fn(), seen = [], calls = [];
    const client = {
      streaming: true, streamFailed: vi.fn(),
      async events(id, after, signal) {
        calls.push({ id, after });
        if (calls.length > 1) return new Response(frame({ seq: 1, type: 'text', delta: '重复' }) + frame(done));
        firstSignal = signal;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ seq: 1, type: 'text', delta: '第一段' }))); } }));
      }
    };
    const observing = followTask(client, 'same-task', { onEvent: e => seen.push(e), retryMs: [10000], subscribeResume: fn => { wake = fn; return unsubscribe; } });
    await until(() => seen.length === 1);
    const started = Date.now(); wake();
    expect(await observing).toEqual(done);
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toEqual([{ id: 'same-task', after: 0 }, { id: 'same-task', after: 1 }]);
    expect(firstSignal.aborted).toBe(true);
    expect(seen).toEqual([{ seq: 1, type: 'text', delta: '第一段' }, done]);
    expect(client.streamFailed).not.toHaveBeenCalled(); expect(unsubscribe).toHaveBeenCalledOnce();
    wake(); expect(calls).toHaveLength(2);
  });

  it('网络恢复打断长退避，但真正连续失败仍在原次数上限结束', async () => {
    let wake;
    const events = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const observing = followTask({ events }, 'same-task', { retryMs: [10000], maxConsecutiveFailures: 2, subscribeResume: fn => { wake = fn; } });
    const result = observing.catch(e => e);
    await until(() => events.mock.calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 5)); wake();
    expect(await result).toMatchObject({ code: 'TASK_OBSERVATION_LOST' });
    expect(events).toHaveBeenCalledTimes(2);
  });

  it('用户停止后前台事件不会复活任务或观察连接', async () => {
    let wake;
    const ctrl = new AbortController(), events = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    const observing = followTask({ events }, 'same-task', { signal: ctrl.signal, subscribeResume: fn => { wake = fn; } });
    const checked = expect(observing).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => events.mock.calls.length === 1); ctrl.abort(); await checked; wake();
    expect(events).toHaveBeenCalledTimes(1);
  });
});

describe('轻量读取和原生物理超时', () => {
  it('五秒读取期限传到原生层，原有文件上传期限独立保留', async () => {
    const request = vi.fn(async () => ({ status: 200, data: '{}', headers: {} }));
    const native = nativeFetcher({ request });
    const client = createServerClient({ base: 'https://fixture.invalid', fetchImpl: native });
    await client.getConfig();
    expect(request.mock.calls[0][0]).toMatchObject({ connectTimeout: QUICK_READ_MS, readTimeout: QUICK_READ_MS });
    await client.upload('测试.txt', new Blob(['原文']));
    expect(request.mock.calls[1][0]).toMatchObject({ connectTimeout: 20000, readTimeout: 120000, method: 'PUT' });
    await native('https://fixture.invalid/legacy');
    expect(request.mock.calls[2][0]).toMatchObject({ connectTimeout: 20000, readTimeout: 180000 });
  });

  it('轻量读取最多两次五秒，不保留原20+20秒等待', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise(() => {}));
      const client = createServerClient({ base: 'https://fixture.invalid', fetchImpl });
      const checked = expect(client.getConfig()).rejects.toMatchObject({ kind: 'timeout' });
      await vi.advanceTimersByTimeAsync(11000); await checked;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('前台唤醒合并在途探测，失败只探测一次；新一轮前台可绕过30秒节流', async () => {
    let resolve;
    const fetchImpl = vi.fn(() => new Promise(r => { resolve = r; }));
    const client = createServerClient({ base: 'https://fixture.invalid', fetchImpl });
    const first = client.warm({ force: true }); client.warm({ force: true }); client.warm();
    await until(() => fetchImpl.mock.calls.length === 1); resolve(new Response('{}')); await first;
    const second = client.warm({ force: true }); await until(() => fetchImpl.mock.calls.length === 2); resolve(new Response('{}')); await second;
    const offline = vi.fn(async () => { throw new TypeError('offline'); });
    await createServerClient({ base: 'https://fixture.invalid', fetchImpl: offline }).warm({ force: true });
    expect(offline).toHaveBeenCalledOnce();
  });

  it('旧登录换发采用服务器确认的主人身份，之后可保存无凭据预览', async () => {
    const map = new Map();
    const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
    vi.stubGlobal('localStorage', storage);
    try {
      const base = 'https://migration-fixture.invalid', old = 'a'.repeat(64), token = 'n'.repeat(43);
      saveServerSettings({ url: base, token: old, enabled: true }, storage);
      const fetchImpl = vi.fn(async url => new Response(JSON.stringify(String(url).endsWith('/auth/migrate')
        ? { token, userId: 'owner', role: 'owner' } : { provider: 'custom', models: { custom: '主人模型' } })));
      const client = createServerClient({ base, token: old, fetchImpl });
      await client.getConfig();
      expect(loadServerSettings(storage)).toMatchObject({ token, userId: 'owner', role: 'owner', enabled: true });
      expect(client.account.userId).toBe('owner');
      const preview = storage.getItem('jarvis.server.model-preview.v1');
      expect(preview).toContain('主人模型'); expect(preview).not.toContain(token);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });
});
