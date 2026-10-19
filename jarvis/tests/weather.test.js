import { describe, it, expect } from 'vitest';
import { getWeather, wmoText } from '../src/agent/weather.js';
import { createSearch, DESKTOP_HEADERS } from '../src/agent/webSearch.js';
import { createTools } from '../src/agent/tools.js';
import { CORE } from '../src/agent/toolLoader.js';

const GEO = { results: [{ name: '南京', latitude: 32.06, longitude: 118.78, admin1: '江苏', country: '中国' }] };
const FC = {
  current: { time: '2026-10-15T13:45', temperature_2m: 21.4, apparent_temperature: 20.6, relative_humidity_2m: 62, weather_code: 2, wind_speed_10m: 9.8, precipitation: 0 },
  daily: { time: ['2026-10-15', '2026-10-16', '2026-10-17'], weather_code: [2, 61, 3], temperature_2m_max: [24.1, 20.2, 22], temperature_2m_min: [15.3, 14.8, 13.9], precipitation_probability_max: [10, 80, 20] }
};
const ok = (j) => new Response(JSON.stringify(j), { status: 200 });

describe('查天气', () => {
  it('Open-Meteo：中文地名 → 实况和三天预报', async () => {
    const asked = [];
    const text = await getWeather('南京市', { get: async (u) => { asked.push(u); return ok(/geocoding/.test(u) ? GEO : FC); } });
    expect(asked[0]).toContain(`name=${encodeURIComponent('南京')}&`); // 去掉“市”再查
    expect(text).toContain('地点：南京，江苏，中国');
    expect(text).toContain('多云，21°C');
    expect(text).toMatch(/明天（2026-10-16）：小雨，15～20°C，降水概率 80%/);
    expect(wmoText(95)).toBe('雷阵雨');
  });

  it('Open-Meteo 连不上时换 wttr.in；都不行时提示改用搜索', async () => {
    const wttr = { current_condition: [{ temp_C: '19', FeelsLikeC: '18', humidity: '70', windspeedKmph: '12', lang_zh: [{ value: '局部多云' }] }], weather: [{ date: '2026-10-15', mintempC: '15', maxtempC: '23', hourly: [{ chanceofrain: '0' }, { chanceofrain: '30', lang_zh: [{ value: '小雨' }] }] }] };
    const text = await getWeather('南京', { get: async (u) => (/open-meteo/.test(u) ? new Response('', { status: 503 }) : ok(wttr)) });
    expect(text).toContain('局部多云，19°C');
    expect(text).toContain('降水概率 30%');
    await expect(getWeather('南京', { get: async () => { throw new TypeError('Failed to fetch'); } })).rejects.toThrow(/web_search/);
  });

  it('天气工具常驻，模型问天气时直接可用', () => {
    expect(createTools({}).some((t) => t.name === 'get_weather')).toBe(true);
    expect(CORE.has('get_weather')).toBe(true);
  });
});

describe('搜索用电脑版页面', () => {
  it('读搜索结果页带电脑浏览器的请求头（手机请求头会拿到手机版页面，解析不出结果）', async () => {
    const inits = [];
    const s = createSearch({ searchRegion: 'cn', fetchViaGateway: async (url, init) => { inits.push(init); return new Response('<html></html>'); } });
    await s.search('南京 天气').catch(() => {}); // 空页面：都没结果，会报原因
    expect(inits.length).toBeGreaterThan(0);
    for (const i of inits) expect(i.headers['User-Agent']).toMatch(/Windows NT/);
    expect(DESKTOP_HEADERS['User-Agent']).not.toMatch(/Mobile|Android/);
  });
});
