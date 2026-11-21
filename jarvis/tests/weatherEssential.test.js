import { describe, it, expect } from 'vitest';
import { getWeather } from '../src/agent/weather.js';
import { weatherPlace, lookupPlan } from '../src/agent/lookup/plan.js';
import { localLookupFailure, consecutiveLookupFailures } from '../src/agent/lookup/healthPolicy.js';

describe('对话必要天气与重查', () => {
  it('附加接口不可达时普通天气不请求它们，只用城市、实况、预报完成', async () => {
    const paths = [];
    const result = await getWeather('南京', { qweather: { key: 'fixture', host: 'weather.example.com' }, get: async url => {
      const path = new URL(url).pathname; paths.push(path);
      const data = path.includes('/city/') ? { code: '200', location: [{ name: '南京', lat: '32', lon: '119' }] }
        : path.endsWith('/now') ? { code: '200', now: { temp: '18', text: '阴', obsTime: '2026-11-03T12:00+08:00' } }
        : path.endsWith('/7d') ? { code: '200', daily: [{ fxDate: '2026-11-04', tempMin: '13', tempMax: '19', textDay: '雨' }] } : null;
      if (!data) throw new Error('附加接口不可用');
      return new Response(JSON.stringify(data));
    } });
    expect(result).toContain('来源：和风天气');
    expect(result).toContain('13～19');
    expect(paths).toEqual(['/geo/v2/city/lookup', '/v7/weather/now', '/v7/weather/7d']);
  });
  it('重查措辞不变成城市，无地点不猜南京', () => {
    expect(weatherPlace('再查下天气')).toBeNull();
    expect(weatherPlace('再查下南京天气')).toBe('南京');
    expect(weatherPlace('再查下天气', { city: '南京' })).toBe('南京');
  });
  it('明确查询空气质量时保留完整维度', () => {
    expect(lookupPlan({ lookup: true, kind: 'weather', params: { city: '南京' } }, { text: '南京空气质量', getTool: () => ({}) }).args).toEqual({ place: '南京', details: true });
  });
  it('白名单拦截不计连接故障，也不让历史误记样本续冷却', () => {
    expect(localLookupFailure({ code: 'PUBLIC_JSON_BLOCKED' })).toBe(true);
    expect(consecutiveLookupFailures(Array.from({ length: 3 }, () => ({ code: 'PUBLIC_JSON_BLOCKED', connected: false, providerFailure: true })))).toBe(false);
  });
});
