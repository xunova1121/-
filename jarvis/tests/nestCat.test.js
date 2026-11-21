import { describe, expect, it } from 'vitest';
import { createCatBehavior, naturalCatState } from '../src/app/nestCat.js';

function cat(storage = new Map()) {
  return createCatBehavior({ read: key => storage.get(key), write: (key, value) => storage.set(key, value) });
}
const morning = new Date(2026, 10, 20, 7);
const after = (at, ms) => new Date(+at + ms);

describe('小窝橘猫', () => {
  it('在晨昏更活跃，午后更常蜷睡，夜间也会自己醒来洗脸', () => {
    function states(start, end) {
      const values = [];
      for (let h = start; h < end; h++) {
        for (let m = 0; m < 60; m += 12) values.push(naturalCatState(new Date(2026, 10, 20, h, m)));
      }
      return values;
    }
    expect(states(5, 9).filter(x => x === 'alert').length).toBeGreaterThan(states(12, 16).filter(x => x === 'alert').length);
    expect(states(12, 16).filter(x => x === 'asleep').length).toBeGreaterThan(states(17, 21).filter(x => x === 'asleep').length);
    expect(new Set(states(0, 4))).toEqual(new Set(['asleep', 'groom', 'alert']));
  });
  it('闻完手再决定，愿意时每次亲近有自己的耐心，离开后刷新也能继续洗脸', () => {
    const storage = new Map();
    const kitty = cat(storage);
    const strokes = [];
    for (let i = 0; i < 3; i++) {
      const start = after(morning, i * 100000);
      expect(kitty.snapshot(start).state).toBe('alert');
      kitty.interact(start);
      expect(kitty.snapshot(start)).toMatchObject({ state: 'sniff', withCat: true });
      kitty.interact(after(start, 200));
      expect(kitty.snapshot(after(start, 200)).state).toBe('sniff');
      const welcomed = after(start, 2300);
      kitty.advance(welcomed);
      expect(kitty.snapshot(welcomed).state).toBe('welcome');
      let n = 0;
      while (n < 5 && kitty.snapshot(welcomed).state !== 'rest') { kitty.interact(welcomed); n++; }
      expect(kitty.snapshot(welcomed)).toMatchObject({ state: 'rest', withCat: false });
      const refreshed = cat(storage);
      refreshed.resume(welcomed);
      refreshed.interact(welcomed);
      expect(refreshed.snapshot(welcomed).state).toBe('rest');
      strokes.push(n);
    }
    expect(new Set(strokes)).toEqual(new Set([2, 3, 4]));
  });
  it('允许闻完后不接受抚摸，晚间作息不会反复来重新要求', () => {
    const storage = new Map();
    const start = new Date(2026, 10, 20, 18, 42);
    const kitty = cat(storage);
    kitty.visitOnce(start);
    expect(kitty.snapshot(start).state).toBe('sniff');
    kitty.advance(after(start, 2300));
    expect(kitty.snapshot(after(start, 2300)).state).toBe('rest');
    const returned = cat(storage);
    returned.visitOnce(after(start, 120000));
    expect(returned.snapshot(after(start, 120000)).withCat).toBe(false);
  });
  it('午睡时先轻唤，有时候只动一下耳朵继续睡', () => {
    const start = new Date(2026, 10, 21, 13);
    const kitty = cat();
    expect(kitty.snapshot(start)).toMatchObject({ state: 'asleep', withCat: false });
    kitty.interact(start);
    expect(kitty.snapshot(start)).toMatchObject({ state: 'listening', withCat: false });
    const awake = after(start, 1800);
    kitty.advance(awake);
    expect(kitty.snapshot(awake).state).toBe('deep');
    kitty.interact(awake);
    expect(kitty.snapshot(awake).withCat).toBe(false);
  });
  it('有工作时可以中断闻手；挂起很久后回来也不会继续旧互动', () => {
    const kitty = cat();
    kitty.interact(morning);
    kitty.leave(morning);
    expect(kitty.snapshot(morning)).toMatchObject({ state: 'alert', withCat: false });
    kitty.interact(morning);
    const later = after(morning, 3600000);
    kitty.advance(later);
    expect(kitty.snapshot(later).withCat).toBe(false);
  });
});
