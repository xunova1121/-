import { retryRead, httpError, throwControl } from '../core/networkRequest.js';
import { errorKind } from '../core/suggest.js';
import { fetchQWeather, parseQWeather, lookupQWeatherCity, formatQWeather } from '../core/qweather.js';
/**
 * 查天气：不走搜索引擎（天气在搜索结果页里是特殊卡片，抓网页抓不到），直接问免费的天气接口，不用密钥。
 *   1. Open-Meteo：先用地名查经纬度（支持中文地名），再取实况和未来几天预报
 *   2. 连不上时换 wttr.in
 * 结果整理成中文文字，交给模型回答。
 */
const WMO = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '冻雾',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '中阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹'
};
export const wmoText = (code) => WMO[code] ?? `天气代码 ${code}`;

const DAY = ['今天', '明天', '后天'];
const round = (v) => (typeof v === 'number' ? Math.round(v) : v);

/** Open-Meteo 的两个返回结果 → 中文说明 */
export function formatOpenMeteo(place, fc, days = 3, dataUrl = '') {
  const c = fc.current ?? {};
  const where = [place.name, place.admin1, place.country].filter((x, i, a) => x && a.indexOf(x) === i).join('，');
  const lines = [`地点：${where}`];
  if (c.time) lines.push(`实况（${c.time.replace('T', ' ')}）：${wmoText(c.weather_code)}，${round(c.temperature_2m)}°C（体感 ${round(c.apparent_temperature)}°C），湿度 ${round(c.relative_humidity_2m)}%，风速 ${round(c.wind_speed_10m)} km/h${c.precipitation ? `，降水 ${c.precipitation} mm` : ''}`);
  const d = fc.daily ?? {};
  for (let i = 0; i < Math.min(days, d.time?.length ?? 0); i++) {
    const rain = d.precipitation_probability_max?.[i];
    lines.push(`${DAY[i] ?? d.time[i]}（${d.time[i]}）：${wmoText(d.weather_code?.[i])}，${round(d.temperature_2m_min?.[i])}～${round(d.temperature_2m_max?.[i])}°C${rain != null ? `，降水概率 ${rain}%` : ''}`);
  }
  lines.push('来源：Open-Meteo（open-meteo.com）');
  // 本次实际取数的链接：回答引用来源时给这个，不给官网首页（第二轮 30 题：只给首页，对不上当天数据）
  if (dataUrl) lines.push(`本次数据链接（引用来源时给这个，不要只给首页）：${dataUrl}`);
  return lines.join('\n');
}

/** wttr.in 的 j1 格式 → 中文说明 */
export function formatWttr(placeName, j, days = 3, dataUrl = '') {
  const c = j.current_condition?.[0] ?? {};
  const desc = (x) => x?.lang_zh?.[0]?.value || x?.weatherDesc?.[0]?.value || '';
  const area = j.nearest_area?.[0];
  const where = [area?.areaName?.[0]?.value, area?.region?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join('，') || placeName;
  const lines = [`地点：${where}`, `实况：${desc(c)}，${c.temp_C}°C（体感 ${c.FeelsLikeC}°C），湿度 ${c.humidity}%，风速 ${c.windspeedKmph} km/h`];
  (j.weather ?? []).slice(0, days).forEach((w, i) => {
    const noon = w.hourly?.[4] ?? w.hourly?.[0];
    const rain = Math.max(0, ...(w.hourly ?? []).map((h) => Number(h.chanceofrain) || 0));
    lines.push(`${DAY[i] ?? w.date}（${w.date}）：${desc(noon)}，${w.mintempC}～${w.maxtempC}°C，降水概率 ${rain}%`);
  });
  lines.push('来源：wttr.in');
  if (dataUrl) lines.push(`本次数据链接（引用来源时给这个，不要只给首页）：${dataUrl}`);
  return lines.join('\n');
}

/**
 * @param {string} place 地名（中文或英文）
 * @param {{ get: (url: string) => Promise<Response>, days?: number }} o
 */
export async function getWeather(place, { get, days = 3, signal, retrieval, qweather = null }) {
  if (!String(place || '').trim()) throw Object.assign(new Error('缺少地点，请提供城市或定位结果，不能默认猜测城市'), { code: 'WEATHER_LOCATION_REQUIRED', name: 'ValidationError' });
  const name = String(place || '').trim().replace(/(市|区|县)$/, '') || '北京';
  const json = url => retryRead(async requestSignal => { const response = await get(url, { signal: requestSignal }); if (!response.ok) throw httpError(response.status, '', '天气服务'); return response.json(); }, { signal, timeoutMs: 4000, beforeAttempt: () => retrieval?.consume('read') });
  let firstErr;
  // 和风天气（填了 Key 时）：国内快、维度多；失败了再走 Open-Meteo。Key 同时放在请求头和 key 参数里：经网关转发网页时请求头会丢
  if (qweather) {
    try {
      retrieval?.consume('read');
      const fetchImpl = (url, init) => get(`${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(qweather.key)}`, init);
      const city = (await lookupQWeatherCity({ ...qweather, query: name, fetchImpl, signal }))[0];
      if (!city) throw new Error(`没找到地点“${name}”`);
      const data = parseQWeather(await fetchQWeather({ ...qweather, latitude: city.latitude, longitude: city.longitude, fetchImpl, signal }));
      return formatQWeather([city.name, city.region].filter(Boolean).join('，'), data, days, city.link);
    } catch (e) { throwControl(e, signal); firstErr = e; }
  }
  try {
    const geo = await json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`);
    const p = geo.results?.[0];
    if (!p) throw new Error(`没找到地点“${name}”`);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation'
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${Math.min(7, Math.max(1, days))}`;
    return formatOpenMeteo(p, await json(url), days, url);
  } catch (e) { throwControl(e, signal); firstErr = e; }
  try {
    return formatWttr(name, await json(`https://wttr.in/${encodeURIComponent(name)}?format=j1&lang=zh`), days, `https://wttr.in/${encodeURIComponent(name)}?lang=zh`);
  } catch (e) {
    throwControl(e, signal);
    throw Object.assign(new Error('天气服务访问失败（' + firstErr?.message + '；' + e.message + '），可以改用web_search查询'), { code: e.code || 'WEATHER_FAILED', kind: errorKind(e) || 'api', status: e.status, cause: e });
  }
}
