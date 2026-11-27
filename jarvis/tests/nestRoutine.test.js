import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatchWorkshopCommand, getWorkshopLife } from '../src/app/workshopLife.js';

function at(day, h, m = 0) {
  const date = new Date(2026, 10, day, h, m);
  vi.setSystemTime(date);
  return date.getTime();
}
beforeEach(() => {
  vi.useFakeTimers();
  at(20, 9);
  dispatchWorkshopCommand('auto');
  dispatchWorkshopCommand('lamp-auto');
});
afterEach(() => vi.useRealTimers());

it('周末书桌的旅行计划到点收起，工作日保留原工位和短休安排', () => {
  at(21, 10);
  const weekend = getWorkshopLife();
  expect(weekend.activity).toBe('trip');
  expect(weekend.nextAt).toBe(new Date(2026, 10, 21, 10, 35).getTime());
  expect(weekend.nextLabel).toContain('哼歌');
  at(20, 10);
  expect(getWorkshopLife().activity).toBe('tidy');
  at(20, 21, 10);
  expect(getWorkshopLife().activity).toBe('trip');
});
it('正打开的草稿或手账有30分钟独立活动，实际任务和恢复作息优先', () => {
  for (const activity of ['trip', 'draft']) {
    const started = at(20, 18, 29);
    expect(dispatchWorkshopCommand(activity)).toBe(true);
    expect(getWorkshopLife()).toMatchObject({ activity, manual: true, nextAt: started + 30 * 60000 });
    expect(getWorkshopLife({ busy: true }).activity).toBe('work');
    expect(dispatchWorkshopCommand('draft', { busy: true })).toBe(false);
    at(20, 18, 31);
    dispatchWorkshopCommand('auto');
    expect(getWorkshopLife()).toMatchObject({ activity: 'cat-visit', manual: false });
  }
});
it('夜睡的下一项活动跨过午夜，真正在清晨醒来', () => {
  at(20, 23, 59);
  const next = new Date(2026, 10, 21, 6, 30).getTime();
  expect(getWorkshopLife()).toMatchObject({ activity: 'sleep', nextAt: next });
  at(21, 1, 10);
  expect(getWorkshopLife()).toMatchObject({ activity: 'sleep', nextAt: next });
});
