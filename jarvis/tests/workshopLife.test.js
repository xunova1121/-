import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorkshopLife, dispatchWorkshopCommand, getWorkshopLife } from '../src/app/workshopLife.js';

const key = 'jarvis.workshopLife.v1';
const opened = [];
const at = (hour, minute = 0, second = 0) => vi.setSystemTime(new Date(2026, 10, 20, hour, minute, second));
let page;

beforeEach(() => {
  vi.useFakeTimers();
  at(9);
  const data = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value)
  });
  page = new EventTarget();
  page.hidden = false;
  vi.stubGlobal('document', page);
  dispatchWorkshopCommand('auto');
  dispatchWorkshopCommand('lamp-auto');
});
afterEach(() => {
  opened.splice(0).forEach((room) => room.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function open(onChange = () => {}) {
  const room = createWorkshopLife({ onChange });
  opened.push(room);
  room.setVisible(true);
  return room;
}

it.each([
  [0, 15, 'sleep', false],
  [7, 5, 'eat', false],
  [7, 32, 'coffee', false],
  [8, 20, 'plan', false],
  [9, 12, 'study', false],
  [9, 38, 'news', false],
  [10, 35, 'sing', false],
  [12, 4, 'eat', false],
  [13, 1, 'sleep', false],
  [14, 0, 'tidy', false],
  [15, 1, 'coffee', false],
  [15, 18, 'study', false],
  [17, 46, 'news', false],
  [18, 10, 'eat', true],
  [19, 10, 'tv', true],
  [19, 36, 'sing', true],
  [22, 29, 'think', true],
  [22, 30, 'sleep', false]
])('按设备当地时间 %i:%i 安排作息与自动灯光', (h, m, activity, lampOn) => {
  at(h, m);
  expect(getWorkshopLife()).toMatchObject({ activity, lampOn, lightMode: 'auto', manual: false });
});

it.each([
  [5, 59, 'night'],
  [6, 0, 'dawn'],
  [7, 59, 'dawn'],
  [8, 0, 'day'],
  [16, 59, 'day'],
  [17, 0, 'dusk'],
  [19, 59, 'dusk'],
  [20, 0, 'night']
])('在当地 %i:%i 切换窗外天色，台灯的手动设置独立生效', (hour, minute, period) => {
  at(hour, minute);
  dispatchWorkshopCommand('lamp-on');
  expect(getWorkshopLife()).toMatchObject({ period, lampOn: true });
  dispatchWorkshopCommand('lamp-off');
  expect(getWorkshopLife()).toMatchObject({ period, lampOn: false });
});

it('早上自己的计划遇到用户任务立即让出工位，跨过午休完成时按当前作息入场', () => {
  at(8, 25);
  const room = open();
  expect(room.snapshot()).toMatchObject({ activity: 'plan', period: 'day', manual: false });
  room.setBusy(true);
  expect(room.snapshot().activity).toBe('work');
  at(14, 5);
  expect(room.snapshot().activity).toBe('work');
  room.setBusy(false);
  expect(room.snapshot()).toMatchObject({ activity: 'tidy', period: 'day', manual: false });
  expect(room.perform('plan')).toBe(false);
  expect(room.perform('tidy')).toBe(false);
  expect(room.perform('study')).toBe(false);
});

it.each([
  [500, 720],
  [805, 1080]
])('从第 %i 到 %i 分钟各工位交替，专注期间穿插短休，日常不计为用户任务', (start, end) => {
  const desks = new Set(['plan', 'tidy', 'study']);
  const visited = new Set();
  let focused = 0, focusStreak = 0, breakStreak = 0;
  for (let minute = start; minute < end; minute++) {
    at(0, minute);
    const { activity } = getWorkshopLife();
    expect(activity).not.toBe('work');
    if (desks.has(activity)) {
      focused++;
      focusStreak++;
      breakStreak = 0;
      visited.add(activity);
    } else {
      breakStreak++;
      focusStreak = 0;
    }
    expect(focusStreak).toBeLessThanOrEqual(45);
    expect(breakStreak).toBeLessThanOrEqual(10);
  }
  expect(visited).toEqual(desks);
  expect(focused / (end - start)).toBeGreaterThan(.75);
});

it('从黄昏工作到深夜，天色照常改变，结束后才熄灯睡觉', () => {
  at(19, 10);
  const room = open();
  expect(room.snapshot()).toMatchObject({ activity: 'tv', period: 'dusk', lampOn: true });
  room.setBusy(true);
  vi.advanceTimersByTime(210 * 60000);
  expect(room.snapshot()).toMatchObject({ activity: 'work', period: 'night', lampOn: true });
  room.setBusy(false);
  expect(room.snapshot()).toMatchObject({ activity: 'sleep', period: 'night', lampOn: false });
});

it('白天空闲动作会变换，同时段重复进入仍然连贯', () => {
  at(9);
  const first = getWorkshopLife();
  at(9, 1);
  expect(getWorkshopLife()).toEqual(first);
  const phases = [9, 31, 53].map((minute) => {
    at(9, minute);
    return getWorkshopLife().label;
  });
  expect(new Set(phases).size).toBe(3);
});

it('清醒时在设备当地的用餐和夜睡边界换场，只在状态有变化时通知', () => {
  at(17, 59, 55);
  const changes = vi.fn();
  open(changes);
  vi.advanceTimersByTime(5000);
  expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ activity: 'eat', label: '正在吃晚饭', period: 'dusk', lampOn: true }));
  vi.advanceTimersByTime(3 * 60000);
  expect(changes).toHaveBeenCalledTimes(2);
});

it('工作和回放优先；工作中的灯仍能控制，真实文件请求不能触发房间碎纸', () => {
  at(2);
  const room = open();
  room.setBusy(true);
  expect(room.snapshot()).toMatchObject({ activity: 'work', manual: false, lampOn: true });
  expect(room.perform('sleep')).toBe(false);
  expect(room.perform('lamp-off')).toBe(true);
  expect(room.snapshot()).toMatchObject({ activity: 'work', lightMode: 'off', lampOn: false });
  room.setBusy(false);
  expect(room.snapshot()).toMatchObject({ activity: 'sleep', lampOn: false });
  for (const command of ['删除 上月报价.xlsx', 'delete_file', 'toString', null, {}, 'lamp-broken']) expect(room.perform(command)).toBe(false);
  expect(room.perform('shred')).toBe(true);
  expect(room.snapshot()).toMatchObject({ activity: 'shred', manual: true });
  vi.advanceTimersByTime(15000);
  expect(room.snapshot()).toMatchObject({ activity: 'sleep', manual: false });
});

it('同一客户端视图和聊天指令即时互通，刷新后保留灯和未过期的手动动作', async () => {
  const pc = open();
  const mobile = vi.fn();
  open(mobile);
  expect(pc.perform('lamp-on')).toBe(true);
  dispatchWorkshopCommand('coffee');
  expect(mobile).toHaveBeenLastCalledWith(expect.objectContaining({ activity: 'coffee', lightMode: 'on', manual: true }));
  vi.resetModules();
  const reloaded = await import('../src/app/workshopLife.js');
  expect(reloaded.getWorkshopLife()).toMatchObject({ activity: 'coffee', lightMode: 'on', manual: true });
  at(12, 2);
  expect(reloaded.getWorkshopLife()).toMatchObject({ activity: 'eat', lightMode: 'on', manual: false });
  expect(pc.perform('tv')).toBe(true);
  expect(pc.perform('auto')).toBe(true);
  expect(pc.snapshot()).toMatchObject({ manual: false, lightMode: 'on' });
  expect(pc.perform('lamp-auto')).toBe(true);
  expect(mobile).toHaveBeenLastCalledWith(expect.objectContaining({ lampOn: false }));
});

it('页面和工作台分别关闭时清除定时器，来日回来直接采用当前时间与存储', () => {
  at(19, 1);
  const changes = vi.fn();
  const room = open(changes);
  expect(room.snapshot().activity).toBe('tv');
  page.hidden = true;
  page.dispatchEvent(new Event('visibilitychange'));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(12 * 60 * 60000);
  expect(changes).toHaveBeenCalledTimes(1);
  localStorage.setItem(key, JSON.stringify({ lightMode: 'on' }));
  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ activity: 'eat', label: '正在吃早饭', lampOn: true }));
  room.setVisible(false);
  expect(vi.getTimerCount()).toBe(0);
  dispatchWorkshopCommand('rest');
  expect(changes).toHaveBeenCalledTimes(2);
  room.setVisible(true);
  expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ activity: 'rest' }));
  room.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('坏记录采用当前作息，存储不可写时仍能操作房间', () => {
  at(12);
  localStorage.setItem(key, '{');
  expect(getWorkshopLife()).toMatchObject({ activity: 'eat', lightMode: 'auto' });
  localStorage.setItem(key, JSON.stringify({ action: '__proto__', startedAt: 123, lightMode: [] }));
  expect(getWorkshopLife()).toMatchObject({ activity: 'eat', lightMode: 'auto' });
  localStorage.setItem = () => {
    throw new Error('quota');
  };
  dispatchWorkshopCommand('sing');
  expect(getWorkshopLife()).toMatchObject({ activity: 'sing', manual: true });
});

it('主动关电视后，本段晚间休息跨页面和工作结束都保持关机，下次看电视时段才恢复', async () => {
  at(19, 10);
  const room = open();
  expect(room.snapshot().activity).toBe('tv');
  expect(room.perform('tv-off')).toBe(true);
  expect(room.snapshot()).toMatchObject({ activity: 'rest', televisionOff: true });
  room.setBusy(true);
  vi.advanceTimersByTime(60000);
  expect(room.snapshot()).toMatchObject({ activity: 'work', televisionOff: true });
  room.setBusy(false);
  room.setVisible(false);
  room.setVisible(true);
  expect(room.snapshot()).toMatchObject({ activity: 'rest', televisionOff: true });
  vi.resetModules();
  const { getWorkshopLife: restored } = await import('../src/app/workshopLife.js');
  expect(restored()).toMatchObject({ activity: 'rest', televisionOff: true });
  at(19, 35);
  expect(room.snapshot()).toMatchObject({ activity: 'sing', televisionOff: false });
  at(20, 30);
  expect(room.snapshot()).toMatchObject({ activity: 'tv', televisionOff: false });
});

it('关掉手动打开的电视会结束观看，手动再次打开即使先前关机也能立即观看', () => {
  at(19, 30);
  const room = open();
  room.perform('tv');
  room.perform('tv-off');
  vi.advanceTimersByTime(6 * 60000);
  expect(room.snapshot()).toMatchObject({ activity: 'sing', televisionOff: true, manual: false });
  room.setBusy(true);
  room.perform('tv');
  expect(room.snapshot()).toMatchObject({ activity: 'work', televisionOff: false });
  room.setBusy(false);
  expect(room.snapshot()).toMatchObject({ activity: 'tv', manual: true });
});

it('点显示器后到电脑前查看，实际任务优先，完成后回到尚未结束的个人活动', () => {
  at(12, 5);
  const room = open();
  expect(room.perform('news')).toBe(true);
  expect(room.snapshot()).toMatchObject({ activity: 'news', manual: true });
  room.setBusy(true);
  expect(room.snapshot().activity).toBe('work');
  expect(room.perform('coffee')).toBe(false);
  room.setBusy(false);
  expect(room.snapshot().activity).toBe('news');
  room.perform('rest');
  expect(room.snapshot().activity).toBe('rest');
  vi.advanceTimersByTime(10 * 60000);
  expect(room.snapshot()).toMatchObject({ activity: 'eat', manual: false });
});
