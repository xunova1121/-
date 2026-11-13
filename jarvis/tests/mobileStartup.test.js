import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initMobileStartup } from '../src/ui/mobileStartup.js';

// 假原生桥/图片等待可复现启动时机，不调用网络或模型。
function setup({ mobile = true, reduced = false, safe = false, absent = false } = {}) {
  const events = {};
  const splash = {
    classList: { add: vi.fn() },
    remove: vi.fn(),
    addEventListener: vi.fn((eventName, callback) => {
      events[eventName] = callback;
    })
  };
  const rootClasses = { add: vi.fn(), contains: () => safe };
  vi.stubGlobal('document', {
    getElementById: () => (absent ? null : splash),
    documentElement: { dataset: { mode: mobile ? 'mobile' : 'desktop' }, classList: rootClasses },
    body: { classList: { contains: () => reduced, toggle: vi.fn(), remove: vi.fn() } }
  });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('requestAnimationFrame', (callback) => callback());
  vi.stubGlobal('dispatchEvent', vi.fn());
  return { splash, events, rootClasses };
}
const ready = () => Promise.resolve();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('手机启动页', () => {
  it.each(['mascot-startup.webp', 'mascot-approved.webp'])('角色素材完整，没有在传输中被截断 %s', (file) => {
    const bytes = readFileSync(new URL('../src/ui/' + file, import.meta.url));
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  });
  it('图片准备好后才揭开主界面；240毫秒内清理，不强制等待两秒', async () => {
    vi.useFakeTimers();
    const { splash, rootClasses } = setup();
    await initMobileStartup({ prepareImages: ready });
    expect(rootClasses.add).toHaveBeenCalledWith('mobile-ui-ready');
    expect(splash.classList.add).toHaveBeenCalledWith('out');
    vi.advanceTimersByTime(240);
    expect(splash.remove).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it('资源延迟期间不提前露出旧光核骨架', async () => {
    vi.useFakeTimers();
    const { splash, rootClasses } = setup();
    let finishLoading;
    const pending = initMobileStartup({
      prepareImages: () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        })
    });
    expect(rootClasses.add).not.toHaveBeenCalled();
    expect(splash.classList.add).not.toHaveBeenCalled();
    finishLoading();
    await pending;
    expect(rootClasses.add).toHaveBeenCalledWith('mobile-ui-ready');
    vi.runAllTimers();
  });
  it('过渡与兜底不重复通知原生主题', async () => {
    vi.useFakeTimers();
    const { splash, events } = setup();
    await initMobileStartup({ prepareImages: ready });
    events.transitionend();
    vi.runAllTimers();
    expect(splash.remove).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it.each([{ reduced: true }, { safe: true }, { mobile: false }])('减少动效、安全模式和桌面不播放退出动画 %j', async (options) => {
    const { splash } = setup(options);
    await initMobileStartup({ prepareImages: ready });
    expect(splash.remove).toHaveBeenCalledTimes(1);
    expect(splash.classList.add).not.toHaveBeenCalled();
  });
  it('图片解码失败显示静态回退标志，并允许进入首页', async () => {
    setup({ reduced: true });
    vi.stubGlobal(
      'Image',
      class {
        decode() {
          return Promise.reject(new Error('broken image'));
        }
      }
    );
    await initMobileStartup();
    expect(document.body.classList.toggle).toHaveBeenCalledWith('mascot-unavailable', true);
    expect(document.documentElement.classList.add).toHaveBeenCalledWith('mobile-ui-ready');
  });
  it('角色资源卡住的等待上限为1500毫秒，不把整个App卡死', async () => {
    vi.useFakeTimers();
    setup({ reduced: true });
    vi.stubGlobal(
      'Image',
      class {
        decode() {
          return new Promise(() => {});
        }
      }
    );
    const pending = initMobileStartup();
    expect(document.documentElement.classList.add).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(document.body.classList.toggle).toHaveBeenCalledWith('mascot-unavailable', true);
    expect(document.documentElement.classList.add).toHaveBeenCalledWith('mobile-ui-ready');
  });
  it('启动节点缺失仍恢复主界面，避免被首帧保护永久遮住', async () => {
    const { rootClasses } = setup({ absent: true });
    await initMobileStartup({ prepareImages: ready });
    expect(rootClasses.add).toHaveBeenCalledWith('mobile-ui-ready');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
