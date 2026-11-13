import { describe, it, expect } from 'vitest';
import { qweatherConfig, fetchQWeather, parseQWeather, formatQWeather, lookupQWeatherCity, qweatherCode } from '../src/core/qweather.js';
import { createWeatherClient } from '../src/core/weather.js';
import { getWeather } from '../src/agent/weather.js';
import { createWeatherProxy } from '../server/weather.mjs';

// 按和风文档的返回格式造的数据（没有真 Key，接不了真接口）
const R = {
  '/geo/v2/city/lookup': { code: '200', location: [{ name: '杭州', lat: '30.29', lon: '120.16', adm2: '杭州', adm1: '浙江省', country: '中国' }] },
  '/v7/weather/now': { code: '200', now: { obsTime: '2026-10-24T09:00+08:00', temp: '18', feelsLike: '17', icon: '305', text: '小雨', windDir: '东北风', windScale: '3', windSpeed: '15', humidity: '88', precip: '0.4', pressure: '1012', vis: '8', cloud: '90', dew: '15' } },
  '/v7/weather/7d': { code: '200', daily: Array.from({ length: 7 }, (_, i) => ({ fxDate: `2026-10-${String(24 + i).padStart(2, '0')}`, sunrise: '06:10', sunset: '17:25', tempMax: String(20 + i), tempMin: String(14 + i), iconDay: i ? '100' : '305', textDay: i ? '晴' : '小雨', textNight: i ? '晴' : '阴', windDirDay: '东北风', windScaleDay: '1-3', humidity: '70', precip: '0.0', uvIndex: '3' })) },
  '/v7/weather/24h': { code: '200', hourly: Array.from({ length: 24 }, (_, i) => ({ fxTime: `2026-10-24T${String((9 + i) % 24).padStart(2, '0')}:00+08:00`, temp: String(18 + (i % 3)), icon: '305', text: '小雨', pop: '60' })) },
  '/airquality/v1/current': { indexes: [{ code: 'cn-mee', aqiDisplay: '42', category: '优', primaryPollutant: null }] },
  '/v7/indices/1d': { code: '200', daily: [{ name: '穿衣指数', category: '较舒适', text: '建议穿薄外套' }, { name: '运动指数', category: '较不宜', text: '有降水' }] },
  '/weatheralert/v1/current': { alerts: [{ headline: '杭州市气象台发布大风蓝色预警', description: '预计今天下午有 6 级大风', color: { code: 'blue' } }] },
  '/v7/minutely/5m': { code: '200', summary: '未来两小时有小雨' }
};
const fake = (seen = []) => async (url, init = {}) => {
  seen.push({ url, init });
  const path = Object.keys(R).find((p) => new URL(url).pathname.startsWith(p));
  return path ? { ok: true, status: 200, json: async () => R[path] } : { ok: false, status: 404, json: async () => ({}) };
};
const QW = { key: 'abc123', host: 'demo.re.qweatherapi.com' };

describe('和风天气', () => {
  it('Key 和 Host 都填了才启用；Host 去掉 https:// 和结尾斜杠；掩码（••••）不算', () => {
    expect(qweatherConfig({ qweatherKey: 'k', qweatherHost: 'https://a.re.qweatherapi.com/' })).toEqual({ key: 'k', host: 'a.re.qweatherapi.com' });
    expect(qweatherConfig({ qweatherKey: 'k' })).toBeNull();
    expect(qweatherConfig({ qweatherKey: '••••1234', qweatherHost: 'a.com' })).toBeNull();
    expect(qweatherCode('305')).toBe(61);
    expect(qweatherCode('100')).toBe(0);
  });

  it('一次取全：实况、逐小时、7 天、空气、生活指数、预警、两小时降水；请求头带 Key', async () => {
    const seen = [];
    const data = parseQWeather(await fetchQWeather({ ...QW, latitude: 30.29, longitude: 120.16, fetchImpl: fake(seen) }), 0);
    expect(seen.every((s) => s.init.headers['X-QW-Api-Key'] === 'abc123')).toBe(true);
    expect(seen[0].url).toBe('https://demo.re.qweatherapi.com/v7/weather/now?location=120.16,30.29');
    expect(data).toMatchObject({ source: 'qweather', temp: 18, code: 61, at: '2026-10-24T09:00', offset: 28800, isDay: true });
    expect(data.days).toHaveLength(7);
    expect(data.days[0]).toMatchObject({ text: '小雨转阴', sunrise: '06:10', uv: 3 });
    expect(data.extra).toMatchObject({ feels: 17, humidity: 88, pressure: 1012, vis: 8, air: { aqi: 42, category: '优' }, rainSoon: '未来两小时有小雨' });
    expect(data.extra.hourly).toHaveLength(24);
    expect(data.extra.alerts[0].title).toMatch(/大风蓝色预警/);
    expect(data.extra.indices.map((i) => i.name)).toEqual(['穿衣指数', '运动指数']);
    const text = formatQWeather('杭州，浙江省', data);
    expect(text).toMatch(/体感 17°C.*湿度 88%.*东北风 3级/);
    expect(text).toMatch(/空气质量：AQI 42（优）/);
    expect(text).toMatch(/来源：和风天气/);
  });

  it('空气质量、预警这些接口不在套餐里（报错）不影响实况；实况拿不到才算失败', async () => {
    const partial = async (url) => (/air|alert|warning|indices|minutely/.test(url) ? { ok: false, status: 403, json: async () => ({}) } : fake()(url, {}));
    const data = parseQWeather(await fetchQWeather({ ...QW, latitude: 30, longitude: 120, fetchImpl: partial }));
    expect(data.extra.air).toBeNull();
    expect(data.extra.alerts).toEqual([]);
    await expect(fetchQWeather({ ...QW, latitude: 30, longitude: 120, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) })).rejects.toThrow(/401/);
  });

  it('对话里问天气：填了和风就用和风（经网关时 Key 也放在参数里）；和风失败再走 Open-Meteo', async () => {
    const seen = [];
    const get = async (url, init) => { seen.push(url); return fake()(url, init); };
    const text = await getWeather('杭州', { get, qweather: QW });
    expect(text).toMatch(/来源：和风天气/);
    expect(seen.every((u) => /[?&]key=abc123/.test(u))).toBe(true);
    const cities = await lookupQWeatherCity({ ...QW, query: '杭州', fetchImpl: fake() });
    expect(cities[0]).toMatchObject({ name: '杭州', latitude: 30.29, region: '浙江省 · 中国' });
  });

  it('首页天气（手机直连）：填了和风就直接查和风，7 天、更多维度存进缓存', async () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    const client = createWeatherClient({ storage, direct: true, fetchImpl: fake(), qweather: () => QW, now: () => Date.parse('2026-10-24T01:00:00Z') });
    await client.select({ name: '杭州', latitude: 30.29, longitude: 120.16 });
    expect(client.state.status).toBe('ready');
    expect(client.state.data.days).toHaveLength(7);
    expect(client.state.data.extra.air.aqi).toBe(42);
    const cities = await client.search('杭州市');
    expect(cities[0].name).toBe('杭州');
  });

  it('服务器代查：服务器上有 Key 就查和风、原样打包给网页；没有就照旧转 Open-Meteo', async () => {
    const proxy = createWeatherProxy({ fetchImpl: fake(), qweather: () => QW });
    const raw = await proxy('/api/weather', new URLSearchParams({ latitude: '30.29', longitude: '120.16' }));
    expect(raw.source).toBe('qweather');
    expect(parseQWeather(raw).temp).toBe(18);
    const cities = await proxy('/api/weather/cities', new URLSearchParams({ q: '杭州' }));
    expect(cities.results[0]).toMatchObject({ name: '杭州', latitude: 30.29 });
  });
});
