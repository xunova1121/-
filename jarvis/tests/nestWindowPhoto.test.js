import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acceptsFramePhoto } from '../src/ui/nestPhoto.js';
import { createNestWindow } from '../src/ui/nestWindow.js';

it('相框限制本地上传类型和大小，兼容系统选图只给扩展名', () => {
  const ok = { size: 123456, type: 'image/jpeg', name: 'family.jpg' };
  expect(acceptsFramePhoto(ok)).toBe(true);
  expect(acceptsFramePhoto({ ...ok, type: '', name: 'FAMILY.WEBP' })).toBe(true);
  expect(acceptsFramePhoto({ ...ok, type: 'image/png', size: 12 * 1024 * 1024 })).toBe(true);
  expect(acceptsFramePhoto({ ...ok, type: 'image/svg+xml', name: 'not-a-photo.png' })).toBe(false);
  expect(acceptsFramePhoto({ ...ok, size: 12 * 1024 * 1024 + 1 })).toBe(false);
  expect(acceptsFramePhoto({ ...ok, size: 0 })).toBe(false);
});

function element() {
  return {
    dataset: {}, children: [], cloneNode: element,
    classList: { contains: () => false, toggle: () => {} },
    setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    getAttribute(name) { return this[name]; },
    after() {}, remove() {}, focus() {}
  };
}

const values = new Map();
let world, panel, sash, reduceMotion;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 20, 10));
  values.clear();
  reduceMotion = false;
  const page = Object.assign(new EventTarget(), { createElement: element, body: element(), hidden: false });
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    matchMedia: () => Object.assign(new EventTarget(), { matches: reduceMotion })
  }));
  vi.stubGlobal('localStorage', { getItem: key => values.get(key) ?? null, setItem: (key, v) => values.set(key, v) });
  world = element();
  panel = { isOpen: vi.fn(() => false), open: vi.fn() };
});
afterEach(() => {
  sash?.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function enter() {
  sash = createNestWindow({ world, panel, art: element() });
  sash.setVisible(true);
  sash.open(element());
  return Object.fromEntries(panel.open.mock.lastCall[0].content.children.map(el => [el.dataset.nestWindow, el]));
}

it('落闩后定时阵风不会打开，重进同一住所仍保持，手动推开可复原', () => {
  let controls = enter();
  controls.latch.onclick();
  expect(world.dataset.windowState).toBe('latched');
  vi.advanceTimersByTime(1_000_000);
  expect(world.dataset.windowState).toBe('latched');
  sash.dispose();
  controls = enter();
  expect(world.dataset.windowState).toBe('latched');
  controls.toggle.onclick();
  expect(world.dataset.windowState).toBe('open');
  vi.advanceTimersByTime(6000);
  expect(world.dataset.windowState).toBe('open');
});

it('有人在填写手账、阅读或退到后台时，不会突然吹开窗', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  enter();
  panel.isOpen.mockReturnValue(true);
  vi.advanceTimersByTime(75001);
  expect(world.dataset.windowState).toBe('ajar');
  panel.isOpen.mockReturnValue(false);
  vi.advanceTimersByTime(75000);
  expect(world.dataset.windowState).toBe('breeze');
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(world.dataset.windowState).toBe('ajar');
  vi.advanceTimersByTime(240000);
  expect(world.dataset.windowState).toBe('ajar');
});

it('手机兼容显示中窗户不启动阵风，仍可手动开窗和落闩', () => {
  document.documentElement = { classList: { contains: name => name === 'safe-render' } };
  const controls = enter();
  expect(vi.getTimerCount()).toBe(0);
  controls.toggle.onclick();
  expect(world.dataset.windowState).toBe('open');
  expect(vi.getTimerCount()).toBe(0);
  controls.latch.onclick();
  expect(world.dataset.windowState).toBe('latched');
});

it('减少动态时可以手动推窗，远眺日夜随当地时间，不随室内开灯改变', () => {
  reduceMotion = true;
  const controls = enter();
  vi.advanceTimersByTime(240000);
  expect(world.dataset.windowState).toBe('ajar');
  controls.toggle.onclick();
  expect(world.dataset.windowState).toBe('open');
  controls.look.onclick();
  const image = panel.open.mock.lastCall[0].content.children[0];
  const daytime = image.src;
  panel.isOpen.mockImplementation(kind => kind === 'view');
  sash.render({ lampOn: false });
  expect(image.src).toBe(daytime);
  vi.setSystemTime(new Date(2026, 10, 20, 23));
  sash.render({ lampOn: true });
  expect(image.src).not.toBe(daytime);
  expect(image.alt).toContain('月光');
});
