/** 屏幕常亮：说话时不灭，久不碰调暗，干长任务不管屏幕 */
import { describe, it, expect } from 'vitest';
import { screenPlan, DIM_AFTER_MS } from '../src/core/screenAwake.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';

describe('屏幕常亮规则', () => {
  it('默认是智能档', () => {
    expect(DEFAULT_SETTINGS.screenAwake).toBe('smart');
  });
  it('智能：说话时不灭；30 秒没碰调暗；说完放开', () => {
    expect(screenPlan({ talking: true, idleMs: 5000 })).toEqual({ keep: true, dim: false });
    expect(screenPlan({ talking: true, idleMs: DIM_AFTER_MS })).toEqual({ keep: true, dim: true });
    expect(screenPlan({ talking: false, idleMs: 60_000 })).toEqual({ keep: false, dim: false });
  });
  it('智能：只是在干长任务、没说话——屏幕可以灭，任务在后台继续', () => {
    expect(screenPlan({ mode: 'smart', talking: false })).toEqual({ keep: false, dim: false });
  });
  it('一直常亮：前台就不灭，也不调暗；跟随系统：什么都不管', () => {
    expect(screenPlan({ mode: 'always', idleMs: 10 * 60_000 })).toEqual({ keep: true, dim: false });
    expect(screenPlan({ mode: 'system', talking: true, idleMs: 60_000 })).toEqual({ keep: false, dim: false });
  });
  it('App 到了后台：一律放开', () => {
    for (const mode of ['smart', 'always']) expect(screenPlan({ mode, talking: true, foreground: false })).toEqual({ keep: false, dim: false });
  });
});
