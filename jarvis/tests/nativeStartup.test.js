import { afterEach, describe, expect, it, vi } from 'vitest';
import { initMobileStartup } from '../src/ui/mobileStartup.js';

function setup({ hidden = false, safe = false, reduced = false } = {}) {
  vi.useFakeTimers();
  class Element extends EventTarget {
    constructor() {
      super();
      this.classes = new Set();
      this.classList = { contains: x => this.classes.has(x), add: x => this.classes.add(x), remove: x => this.classes.delete(x) };
      this.remove = vi.fn();
      this.removeAttribute = vi.fn();
      this.children = [];
      this.append = child => this.children.push(child);
      this.querySelector = () => null;
    }
  }
  const root = new Element();
  root.dataset = { mode: 'mobile' };
  root.classList.add('mobile-app');
  if (safe) root.classList.add('safe-render');
  const splash = new Element();
  const animation = { currentTime: 1200, play: vi.fn() };
  splash.getAnimations = () => [animation];
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const windowEvents = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    hidden, documentElement: root,
    body: { classList: { contains: () => reduced, toggle: vi.fn() } },
    getElementById: () => splash, querySelector: () => null,
    createElement: () => new Element()
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('matchMedia', () => motion);
  vi.stubGlobal('requestAnimationFrame', callback => callback());
  vi.stubGlobal('addEventListener', windowEvents.addEventListener.bind(windowEvents));
  vi.stubGlobal('removeEventListener', windowEvents.removeEventListener.bind(windowEvents));
  vi.stubGlobal('dispatchEvent', windowEvents.dispatchEvent.bind(windowEvents));
  return { root, splash, animation, doc, motion };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('APK快速启动可见动画', () => {
  it('图片瞬间就绪也从首帧播放完整1.6秒，再在原240毫秒内退出', async () => {
    const { splash, root, animation } = setup();
    const pending = initMobileStartup({ prepareImages: async () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.classList.contains('mobile-ui-ready')).toBe(true);
    expect(splash.classList.contains('native-playing')).toBe(true);
    expect(animation.currentTime).toBe(0);
    expect(animation.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1599);
    expect(splash.classList.contains('out')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(splash.classList.contains('out')).toBe(true);
    await vi.advanceTimersByTimeAsync(240);
    expect(splash.remove).toHaveBeenCalledOnce();
  });
  it.each(['skip', 'background', 'memory', 'reduce'])('%s立即退出，清理后返回前台不重播', async kind => {
    const { splash, doc, motion } = setup();
    const pending = initMobileStartup({ prepareImages: async () => true });
    await vi.advanceTimersByTimeAsync(0);
    const skip = splash.children[0];
    if (kind === 'skip') skip.dispatchEvent(new Event('click'));
    if (kind === 'background') { doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); }
    if (kind === 'memory') dispatchEvent(new Event('jarvis:memory-pressure'));
    if (kind === 'reduce') { motion.matches = true; motion.dispatchEvent(new Event('change')); }
    await pending;
    expect(splash.classList.contains('out')).toBe(true);
    expect(skip.remove).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(240);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(splash.remove).toHaveBeenCalledOnce();
    expect(splash.classList.contains('native-playing')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([{ safe: true }, { reduced: true }, { hidden: true }])('已有%j保护时不强制播放', async options => {
    const { splash, root } = setup(options);
    await initMobileStartup({ prepareImages: async () => true });
    expect(root.classList.contains('mobile-ui-ready')).toBe(true);
    expect(splash.children).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(240);
    expect(splash.remove).toHaveBeenCalledOnce();
  });
  it.each([false, 'reject'])('资源失败%s不等待动画，首页仍可用', async failure => {
    const { splash, root } = setup();
    await initMobileStartup({ prepareImages: async () => { if (failure === 'reject') throw new Error('decode'); return false; } });
    expect(root.classList.contains('mobile-ui-ready')).toBe(true);
    expect(splash.children).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(240);
    expect(splash.remove).toHaveBeenCalledOnce();
  });
});
