import { afterEach, expect, it, vi } from 'vitest';
import { getWeather } from '../src/agent/weather.js';
import { runLookup } from '../src/agent/lookup/runner.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { createRetrievalBudget, createLookupClock, LOOKUP_TOTALS } from '../src/agent/lookup/clock.js';
import { runLookupOperation } from '../src/agent/lookup/operations.js';
const qweather = { key: 'fixture-private-key', host: 'weather.example.com' };
const ok = value => ({ ok: true, json: async () => value });
const geo = { results: [{ name: '南京', country: '中国', latitude: 32, longitude: 118 }] };
const forecast = { current: { time: '2026-10-31T10:00', weather_code: 0, temperature_2m: 18, apparent_temperature: 18, relative_humidity_2m: 60, wind_speed_10m: 10 }, daily: { time: ['2026-10-31'], weather_code: [0], temperature_2m_min: [11], temperature_2m_max: [22] } };
const wttr = { current_condition: [{ temp_C: '18', FeelsLikeC: '18', humidity: '60', windspeedKmph: '10', lang_zh: [{ value: '晴' }] }], weather: [{ date: '2026-10-31', mintempC: '11', maxtempC: '22', hourly: [] }] };
const free = url => ok(url.includes('geocoding') ? geo : forecast);
afterEach(() => vi.useRealTimers());

it('API超时5秒后才启用免费源，忽略signal的旧请求迟到也不再发新请求', async () => {
  vi.useFakeTimers(); const seen = []; let late, primarySignal;
  const get = async (url, options) => {
    seen.push(url);
    if (url.includes(qweather.host)) { primarySignal = options.signal; return new Promise(resolve => { late = resolve; }); }
    expect(url).not.toContain(qweather.key); expect(options.headers).toBeUndefined();
    return free(url);
  };
  const pending = getWeather('南京', { qweather, get });
  await vi.advanceTimersByTimeAsync(4999); expect(seen).toHaveLength(2); expect(seen.every(row => String(row.url || row).includes(qweather.host))).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toContain('来源：Open-Meteo'); expect(primarySignal.aborted).toBe(true);
  const count = seen.length;
  late(ok({ code: '200', location: [{ name: '南京', lat: '32', lon: '118' }] }));
  await vi.advanceTimersByTimeAsync(1); expect(seen).toHaveLength(count);
});

it('真实runner/操作层：和风及第一免费源均卡住，仍能在14秒内启用wttr而非提前截断', async () => {
  vi.useFakeTimers(); const seen = [];
  const clock = createLookupClock({ totalMs: LOOKUP_TOTALS.weather, phased: true });
  const retrieval = createRetrievalBudget('南京天气', { clock });
  const get = async url => { seen.push(url); return url.includes('wttr.in') ? ok(wttr) : new Promise(() => {}); };
  const tool = { name: 'get_weather', run: (_, execution) => getWeather('南京', { qweather, get, ...execution }) };
  const pending = runLookup(lookupIntent('南京天气'), { text: '南京天气', clock, getTool: () => tool, execute: async (_, signal) => {
    retrieval.begin(); return [{ ok: true, output: await runLookupOperation(tool, {}, { retrieval, signal }) }];
  } });
  await vi.advanceTimersByTimeAsync(10001);
  expect((await pending).output).toContain('来源：wttr.in');
  expect(seen[0]).toContain(qweather.host);
  expect(seen.findIndex(url => url.includes('open-meteo'))).toBeGreaterThan(0);
  expect(seen.at(-1)).toContain('wttr.in');
});

it('API明确失败立即切免费；未配置API直接免费；用户停止不再切源', async () => {
  const seen = [];
  const get = async url => { seen.push(url); return url.includes(qweather.host) ? { ok: false, status: 401 } : free(url); };
  expect(await getWeather('南京', { qweather, get })).toContain('Open-Meteo');
  expect(seen[0]).toContain(qweather.host);
  seen.length = 0;
  expect(await getWeather('南京', { get })).toContain('Open-Meteo'); expect(seen.some(url => url.includes(qweather.host))).toBe(false);
  const controller = new AbortController(); const calls = [];
  const pending = getWeather('南京', { qweather, signal: controller.signal, get: async url => { calls.push(url); return new Promise(() => {}); } });
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); controller.abort(); await stopped;
  expect(calls.every(url => url.includes(qweather.host))).toBe(true);
});

it('先等模型9秒选择地点，再等API5秒切免费源：规划等待不能吃掉免费源额度', async () => {
  const { runAgent } = await import('../src/agent/agent.js');
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-31T10:00:00+08:00'));
  let calls = 0; const seen = [];
  const get = async url => {
    seen.push(url);
    if (url.includes(qweather.host)) return new Promise(() => {});
    if (url.includes('geocoding')) await new Promise(resolve => setTimeout(resolve, 2000));
    return free(url);
  };
  const weatherTool = { name: 'get_weather', input_schema: { type: 'object', properties: { place: { type: 'string' } } }, run: (args, execution) => getWeather(args.place, { ...execution, qweather, get }) };
  const pending = runAgent({ userText: '今天天气', model: 'fixture', history: [], context: { dynamic: '' }, emit() {}, tools: [{ ...weatherTool, run: (args, execution) => runLookupOperation(weatherTool, args, execution) }], adapter: { stream: async options => {
    await new Promise(resolve => setTimeout(resolve, 9000));
    if (++calls === 1) return { text: '', toolCalls: [{ id: 'weather', name: 'get_weather', args: { place: '南京' } }], stop: 'tool_use' };
    options.onText('南京今天晴，11～22°C。来源：Open-Meteo https://api.open-meteo.com/');
    return { text: '', toolCalls: [], stop: 'end_turn' };
  } } });
  await vi.advanceTimersByTimeAsync(25001);
  const answer = await pending;
  expect(answer.text).toContain('南京今天晴'); expect(answer.text).not.toMatch(/请求超时|部分完成|再查一会儿/);
  expect(seen[0]).toContain(qweather.host); expect(calls).toBe(2);
});
