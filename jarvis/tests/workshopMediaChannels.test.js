import { afterEach, expect, it, vi } from 'vitest';
import { onWorkshopChannel, selectWorkshopChannel, workshopChannel, workshopChannels } from '../src/ui/workshopMediaChannels.js';

afterEach(() => vi.unstubAllGlobals());

it('只允许四个已知央视频道，默认综合，数字和中文都指向对应官方地址', () => {
  expect(workshopChannels.map(ch => ch.id)).toEqual(['cctv1', 'cctv2', 'cctv9', 'cctv13']);
  expect(selectWorkshopChannel('CCTV-1').id).toBe('cctv1');
  expect(selectWorkshopChannel('换到财经频道').url).toBe('https://tv.cctv.com/live/cctv2/');
  expect(selectWorkshopChannel('切换到 CCTV-13').id).toBe('cctv13');
  expect(selectWorkshopChannel('https://unrelated.example')).toBeNull();
  expect(selectWorkshopChannel('帮我写一份财经频道介绍')).toBeNull();
});

it('选台写入偏好并通知当前界面，离开房间后不再收到通知', () => {
  const storage = new Map();
  vi.stubGlobal('localStorage', { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) });
  const observe = vi.fn();
  const stop = onWorkshopChannel(observe);
  selectWorkshopChannel('cctv9');
  expect(workshopChannel().label).toBe('CCTV-9 纪录');
  expect([...storage.values()]).toEqual(['cctv9']);
  stop();
  selectWorkshopChannel('cctv1');
  expect(observe).toHaveBeenCalledTimes(1);
});
