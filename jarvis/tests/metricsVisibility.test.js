import { expect, it, vi } from 'vitest';
import { MetricsPoller } from '../src/api/metrics.js';
import { browserMetrics } from '../src/api/browserMetrics.js';

it('仪表快速关开时，已取消的读数不会覆盖新窗口，也不会多开一个轮询', async () => {
  vi.useFakeTimers();
  const pending = [];
  const fetch = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const onData = vi.fn();
  const poller = new MetricsPoller({ interval: 3000, onData });
  vi.stubGlobal('fetch', fetch);
  try {
    poller.start();
    poller.stop();
    poller.start();
    const latest = { cpu: { percent: 12 } };
    pending[1](Response.json(latest));
    await vi.advanceTimersByTimeAsync(0);
    pending[0](Response.json({ cpu: { percent: 91 } }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(onData.mock.calls).toEqual([[{ source: 'server', ...latest }]]);
    expect(fetch).toHaveBeenCalledTimes(3);
    poller.stop();
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    poller.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it('停止仪表立即取消单文件采样，模型单独读数后也不会遗留计时器', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { onLine: true });
  const onData = vi.fn();
  const poller = new MetricsPoller({ onData });
  poller.fallback = true;
  try {
    poller.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(40);
    poller.stop();
    expect(vi.getTimerCount()).toBe(0);
    const reading = browserMetrics();
    await vi.advanceTimersByTimeAsync(100);
    expect(await reading).toMatchObject({ source: 'browser', cpu: { percent: expect.any(Number) }, network: { online: true } });
    expect(onData).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    poller.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
