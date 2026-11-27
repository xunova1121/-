import { describe, it, expect } from 'vitest';
import { nativeStreamFetcher, nativeRouter, wantsStream } from '../src/mobile/nativeFetch.js';

/** 假的 NativeStream 插件：start 之后按顺序发 head → data… → end */
function fakePlugin(script) {
  const listeners = new Map();
  const emit = (name, e) => (listeners.get(name) || []).forEach((fn) => fn(e));
  return {
    started: [], cancelled: [],
    addListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); return Promise.resolve({ remove() { listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn)); } }); },
    async start(o) { this.started.push(o); setTimeout(() => script(o.id, emit), 0); },
    async cancel({ id }) { this.cancelled.push(id); }
  };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('手机原生网络：大模型回答边收边显示', () => {
  it('只有流式请求走边收边给', () => {
    expect(wantsStream({ body: '{"model":"x","stream":true}' })).toBe(true);
    expect(wantsStream({ body: '{}', headers: { Accept: 'text/event-stream' } })).toBe(true);
    expect(wantsStream({ body: '{"stream":false}' })).toBe(false);
    expect(wantsStream({})).toBe(false);
  });

  it('一段一段收到，读的一方马上就能拿到前面的字（不用等整段写完）', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const plugin = fakePlugin(async (id, emit) => {
      emit('head', { id, status: 200, headers: { 'content-type': 'text/event-stream' } });
      emit('data', { id, data: b64('data: 你好') });
      await gate; // 后半段还没到
      emit('data', { id, data: b64('，未央\n\n') });
      emit('end', { id });
    });
    const res = await nativeStreamFetcher(plugin)('https://relay.example/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{"stream":true}' });
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('data: 你好'); // 后半段还没来，前半段已经能显示
    release();
    let rest = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toBe('，未央\n\n');
    expect(plugin.started[0]).toMatchObject({ method: 'POST', body: '{"stream":true}', headers: { authorization: 'Bearer k' } });
  });

  it('出错时报网络错误；用户点停止时断开请求', async () => {
    const bad = fakePlugin((id, emit) => emit('error', { id, message: 'timeout' }));
    await expect(nativeStreamFetcher(bad)('https://x', { method: 'POST', body: '{"stream":true}' })).rejects.toThrow(/timeout/);
    const slow = fakePlugin(() => {});
    const ctrl = new AbortController();
    const p = nativeStreamFetcher(slow)('https://x', { method: 'POST', body: '{"stream":true}', signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(p).rejects.toThrow(/Aborted/);
    expect(slow.cancelled).toHaveLength(1);
  });

  it('非流式请求、旧安装包没有插件：走原来的一次性请求', async () => {
    const calls = [];
    const native = async (url, init) => { calls.push(init.body ?? 'GET'); return new Response('ok'); };
    const missing = async () => { throw new Error('"NativeStream" plugin is not implemented on android'); };
    const route = nativeRouter(native, missing);
    expect(await (await route('https://x', { method: 'POST', body: '{"stream":true}' })).text()).toBe('ok');
    expect(await (await route('https://x', {})).text()).toBe('ok');
    expect(calls).toEqual(['{"stream":true}', 'GET']);
  });
});

it('安装原生流插件的手机可直接订阅已选服务器，首段到达时尾段仍未提交', async () => {
  const { wrapFetch } = await import('../src/mobile/nativeFetch.js');
  let finish;
  const calls = [];
  const plugin = fakePlugin((id, emit) => {
    emit('head', { id, status: 200 });
    emit('data', { id, data: b64('首段') });
    finish = () => emit('end', { id });
  });
  const g = { Capacitor: { isPluginAvailable: name => name === 'NativeStream' } };
  const fetch = wrapFetch(async () => { calls.push('web'); return new Response(); }, nativeStreamFetcher(plugin), 'https://localhost', g);
  g.__jarvisPreferNative('d.example.com');
  const response = await fetch('https://d.example.com/events', { stream: true, headers: { Accept: 'text/event-stream' } });
  const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('首段');
  finish();
  expect((await reader.read()).done).toBe(true);
  expect(calls).toEqual([]);
  expect(plugin.started).toHaveLength(1);
});

it('监听尚未就绪时取消不会启动网络，已结束的订阅不再响应旧信号', async () => {
  const ctrl = new AbortController();
  const pending = fakePlugin(() => {});
  const request = nativeStreamFetcher(pending)('https://example.com/events', { signal: ctrl.signal });
  ctrl.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(pending.started).toEqual([]);

  const finished = fakePlugin((id, emit) => { emit('head', { id, status: 200 }); emit('end', { id }); });
  const next = new AbortController();
  const res = await nativeStreamFetcher(finished)('https://example.com/events', { signal: next.signal });
  await res.text();
  next.abort();
  expect(finished.cancelled).toEqual([]);
});
