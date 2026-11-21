import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNestClock } from '../src/ui/nestClock.js';

function element() {
  return Object.assign(new EventTarget(), {
    style: {}, children: [],
    append(...items) { this.children.push(...items); },
    setAttribute(key, value) { this[key] = value; }
  });
}

function mount() {
  const floor = element();
  const art = element();
  const clock = createNestClock(floor, art);
  const face = floor.children[0];
  const [, hour, minute] = face.children;
  clock.setVisible(true);
  return {clock, face, hour, minute};
}

describe('小窝墙钟', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {hidden: false, createElement: element});
    vi.stubGlobal('window', new EventTarget());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('使用本地小时和分钟，整分钟只拨针一次，午夜自动过十二点', () => {
    vi.setSystemTime(new Date(2026, 10, 21, 23, 59, 59, 800));
    const {clock, face, hour, minute} = mount();
    expect(face['aria-label']).toBe('墙钟 23:59');
    expect(hour.style.transform).toBe('rotate(359.5deg)');
    expect(minute.style.transform).toBe('rotate(354deg)');
    vi.advanceTimersByTime(199);
    expect(face.dateTime).toBe('23:59');
    vi.advanceTimersByTime(1);
    expect([face.dateTime, hour.style.transform, minute.style.transform]).toEqual(['00:00', 'rotate(0deg)', 'rotate(0deg)']);
    expect(vi.getTimerCount()).toBe(1);
    clock.setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('隐藏小窝或原生应用切后台即暂停，重新打开、前台和页面恢复都按当前系统时间校准', () => {
    vi.setSystemTime(new Date(2026, 10, 21, 9, 28));
    const {clock, face, hour, minute} = mount();
    const foreground = active => window.dispatchEvent(new CustomEvent('jarvis:foreground', {detail: {active}}));
    foreground(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date(2026, 10, 21, 14, 46));
    expect(face.dateTime).toBe('09:28');
    foreground(true);
    expect([face.dateTime, hour.style.transform, minute.style.transform]).toEqual(['14:46', 'rotate(83deg)', 'rotate(276deg)']);

    clock.setVisible(false);
    vi.setSystemTime(new Date(2026, 10, 21, 15, 12));
    window.dispatchEvent(new Event('pageshow'));
    expect(vi.getTimerCount()).toBe(0);
    expect(face.hidden).toBe(true);
    clock.setVisible(true);
    expect(face.dateTime).toBe('15:12');
    vi.setSystemTime(new Date(2026, 10, 21, 18, 1));
    window.dispatchEvent(new Event('pageshow'));
    expect(face.dateTime).toBe('18:01');
    expect(vi.getTimerCount()).toBe(1);
    clock.setVisible(false);
  });
});
