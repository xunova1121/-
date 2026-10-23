import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initMobileStartup } from '../src/ui/mobileStartup.js';

// 使用假 DOM 验证启动退出时机，不调用网络或真实模型。
function setup({ mobile = true, reduced = false, safe = false } = {}) {
  const events = {};
  const splash = {
    isConnected: true,
    classList: { add: vi.fn() },
    remove: vi.fn(() => { splash.isConnected = false; }),
    addEventListener: vi.fn((name, callback) => { events[name] = callback; })
  };
  vi.stubGlobal('document', {
    getElementById: () => splash,
    documentElement: { dataset: { mode: mobile ? 'mobile' : 'desktop' }, classList: { contains: () => safe } },
    body: { classList: { contains: () => reduced } }
  });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('requestAnimationFrame', (callback) => callback());
  vi.stubGlobal('dispatchEvent', vi.fn());
  return { splash, events };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('手机启动页', () => {
  it.each(['mascot-startup.webp', 'mascot-approved.webp'])('角色素材完整，没有在传输中被截断 %s', (file) => {
    const bytes = readFileSync(new URL('../src/ui/' + file, import.meta.url));
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  });
  it('加载完成后直接淡出，240毫秒内清理，不强制播放两秒', () => {
    vi.useFakeTimers();
    const { splash } = setup();
    initMobileStartup();
    expect(splash.classList.add).toHaveBeenCalledWith('out');
    vi.advanceTimersByTime(240);
    expect(splash.remove).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it('过渡事件和兜底定时器不会重复通知原生主题', () => {
    vi.useFakeTimers();
    const { splash, events } = setup();
    initMobileStartup();
    events.transitionend();
    vi.runAllTimers();
    expect(splash.remove).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it.each([{ reduced: true }, { safe: true }, { mobile: false }])('减少动效、安全模式和桌面立即退出 %j', (options) => {
    const { splash } = setup(options);
    initMobileStartup();
    expect(splash.remove).toHaveBeenCalledTimes(1);
    expect(splash.classList.add).not.toHaveBeenCalled();
  });
  it('启动页已不存在时不重复处理', () => {
    setup();
    document.getElementById = () => null;
    initMobileStartup();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
