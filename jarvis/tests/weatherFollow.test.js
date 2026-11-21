import { it, expect, vi } from 'vitest';
import { createWeatherClient } from '../src/core/weather.js';
import { createWeatherFollow, WEATHER_FOREGROUND_GAP, WEATHER_LOCATION_INTERVAL } from '../src/core/weatherFollow.js';
const stamp = Date.parse('2026-11-02T04:00:00Z');
const here = { name: '南京市 · 江宁区', city: '南京市', district: '江宁区', latitude: 31.95, longitude: 118.84, source: 'location' };
const next = { name: '南京市 · 秦淮区', city: '南京市', district: '秦淮区', latitude: 31.96, longitude: 118.84, source: 'location' };
const raw = (temp) => ({
  utc_offset_seconds: 28800,
  current: { temperature_2m: temp, weather_code: 0, is_day: 1, time: '2026-11-02T12:00' },
  daily: { time: ['2026-11-02'], temperature_2m_min: [10], temperature_2m_max: [25], weather_code: [0], precipitation_probability_max: [0] }
});
const response = (temp) => new Response(JSON.stringify(raw(temp)));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function setup(fetcher = async () => response(20)) {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const fetchImpl = vi.fn(fetcher);
  const client = createWeatherClient({ storage, now: () => stamp, fetchImpl });
  await client.select(here);
  return { client, fetchImpl, storage };
}
it('不到2公里的跨区移动也换位，换位成功前始终保留成对的旧地点与温度', async () => {
  const wait = deferred();
  let pending = false;
  const { client, fetchImpl } = await setup(async () => (pending ? wait.promise : response(20)));
  pending = true;
  const locate = vi.fn(async () => next),
    notice = vi.fn();
  const f = createWeatherFollow({ client, locate, checkPermission: async () => true, onNotice: notice, now: () => stamp });
  const work = f.check({ foreground: true });
  while (fetchImpl.mock.calls.length < 2) await Promise.resolve();
  expect(client.state).toMatchObject({ city: here, data: { temp: 20 }, refreshing: true });
  wait.resolve(response(24));
  expect(await work).toBe(true);
  expect(client.state).toMatchObject({ city: next, data: { temp: 24 }, refreshing: false });
  expect(locate.mock.calls[0][0]).toMatchObject({ maximumAge: 0, requestPermission: false });
  expect(notice).toHaveBeenLastCalledWith('');
});
it('前台双事件合并为一次定位，前台10秒保护不再受30分钟门禁阻塞', async () => {
  const { client } = await setup();
  let time = stamp;
  const locate = vi.fn(async () => here);
  const f = createWeatherFollow({ client, locate, checkPermission: async () => true, now: () => time });
  await Promise.all([f.check({ foreground: true }), f.check({ foreground: true })]);
  expect(locate).toHaveBeenCalledTimes(1);
  time += WEATHER_FOREGROUND_GAP - 1;
  await f.check({ foreground: true });
  expect(locate).toHaveBeenCalledTimes(1);
  time += 2;
  await f.check({ foreground: true });
  expect(locate).toHaveBeenCalledTimes(2);
  time += WEATHER_LOCATION_INTERVAL;
  await f.check();
  expect(locate).toHaveBeenCalledTimes(3);
  expect(locate.mock.calls[2][0].maximumAge).toBe(30000);
});
it('手选城市与后台状态不自动定位；未授权只提示、不弹框或发定位请求', async () => {
  const { client } = await setup();
  const locate = vi.fn(),
    notice = vi.fn();
  let granted = false,
    active = false;
  const f = createWeatherFollow({ client, locate, checkPermission: async () => granted, onNotice: notice, active: () => active });
  await f.check({ foreground: true });
  expect(locate).not.toHaveBeenCalled();
  active = true;
  await f.check({ foreground: true });
  expect(locate).not.toHaveBeenCalled();
  expect(notice.mock.calls.at(-1)[0]).toContain('授权');
  await client.select({ ...here, source: undefined });
  granted = true;
  await f.check({ force: true });
  expect(locate).not.toHaveBeenCalled();
});
it('定位失败有位置待更新说明，保留旧天气且不伪报天气缓存失败', async () => {
  const { client } = await setup();
  const notice = vi.fn();
  const f = createWeatherFollow({
    client,
    locate: async () => {
      throw Error('private-native-detail');
    },
    checkPermission: async () => true,
    onNotice: notice
  });
  expect(await f.check({ foreground: true })).toBe(false);
  expect(client.state).toMatchObject({ city: here, data: { temp: 20 }, error: '' });
  expect(notice.mock.calls.at(-1)[0]).toContain('仍显示江宁区天气');
  expect(notice.mock.calls.at(-1)[0]).not.toContain('private-native-detail');
});
it('新位置天气失败不换地点，显示明确的位置更新提示', async () => {
  let offline = false;
  const { client } = await setup(async () => {
    if (offline) throw Error('network');
    return response(20);
  });
  offline = true;
  const notice = vi.fn();
  const f = createWeatherFollow({ client, locate: async () => next, checkPermission: async () => true, onNotice: notice });
  expect(await f.check({ foreground: true })).toBe(false);
  expect(client.state).toMatchObject({ city: here, data: { temp: 20 }, error: '' });
  expect(notice.mock.calls.at(-1)[0]).toContain('位置未更新');
});
it('迟到定位不能盖掉用户重新指定的同一坐标位置，显式选择版本而非只比经纬度', async () => {
  const { client } = await setup();
  const wait = deferred();
  const f = createWeatherFollow({ client, locate: () => wait.promise, checkPermission: async () => true });
  const work = f.check({ foreground: true });
  await Promise.resolve();
  await client.select({ ...here });
  wait.resolve(next);
  expect(await work).toBe(false);
  expect(client.state.city).toEqual(here);
});
it('同一公里坐标的新区县名能更新，不额外查询天气；缺区名不抹掉已知区名', async () => {
  const { client, fetchImpl } = await setup();
  expect(await client.relocate({ ...next, latitude: here.latitude })).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(client.state.city.district).toBe('秦淮区');
  expect(await client.relocate({ name: '当前位置', latitude: here.latitude, longitude: here.longitude, source: 'location' })).toBe(false);
  expect(client.state.city.district).toBe('秦淮区');
});
it('销毁或离开前台会取消候选天气，迟到响应不写入当前地点或缓存', async () => {
  const wait = deferred();
  let pending = false;
  const { client, fetchImpl, storage } = await setup(async () => (pending ? wait.promise : response(20)));
  pending = true;
  const f = createWeatherFollow({ client, locate: async () => next, checkPermission: async () => true });
  const work = f.check({ foreground: true });
  while (fetchImpl.mock.calls.length < 2) await Promise.resolve();
  f.destroy();
  wait.resolve(response(24));
  expect(await work).toBe(false);
  expect(client.state).toMatchObject({ city: here, data: { temp: 20 }, refreshing: false });
  expect(JSON.parse(storage.getItem('jarvis.weather.city.v1'))).toEqual(here);
});
it('候选天气失败不回滚或盖掉其间用户手选的同一目标坐标', async () => {
  const wait = deferred();
  let count = 0;
  const { client } = await setup(async () => (++count === 2 ? wait.promise : response(25)));
  const work = client.relocate(next);
  await client.select({ ...next, name: '手选秦淮', source: undefined });
  wait.resolve(response(24));
  expect(await work).toBe(false);
  expect(client.state).toMatchObject({ city: { name: '手选秦淮', latitude: next.latitude }, data: { temp: 25 } });
});
it('首次天气还在取数时补齐同坐标区县名，不能取消取数或一直没有温度', async () => {
  const wait = deferred(), fetchImpl = vi.fn(() => wait.promise);
  const client = createWeatherClient({ storage: null, now: () => stamp, fetchImpl });
  const initial = client.select({ name: '当前位置', latitude: here.latitude, longitude: here.longitude, source: 'location' });
  expect(await client.relocate(here)).toBe(true);
  expect(client.state.refreshing).toBe(true);
  wait.resolve(response(21));
  await initial;
  expect(client.state).toMatchObject({ city: here, data: { temp: 21 }, status: 'ready', refreshing: false });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('补齐当前坐标区县名时仍应取消另一坐标的候选天气，迟到候选不能覆盖它', async () => {
  const wait = deferred();
  let pending = false;
  const { client } = await setup(async () => pending ? wait.promise : response(20));
  pending = true;
  const move = client.relocate(next);
  const named = { ...here, name: '南京市 · 新区', district: '新区' };
  expect(await client.relocate(named)).toBe(true);
  wait.resolve(response(24));
  expect(await move).toBe(false);
  expect(client.state).toMatchObject({ city: named, data: { temp: 20 }, status: 'ready', refreshing: false });
});
