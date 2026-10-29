/**
 * 和风天气（QWeather，国内服务，访问快）：填了 Key 和 API Host 就用它，没填照旧用 Open-Meteo（core/weather.js）。
 * 一次拿全：实况、逐小时（24 小时）、7 天预报、空气质量、生活指数、天气预警、未来两小时降水。
 * 认证用请求头 X-QW-Api-Key；API Host 是控制台“设置”里给每个账号的专属地址（如 abc123.re.qweatherapi.com）。
 * 接口说明：https://dev.qweather.com/docs/api/
 */

/** 配置里的 Key 和 Host；不完整返回 null */
export function qweatherConfig(cfg) {
  const key = String(cfg?.qweatherKey || '').trim();
  const host = String(cfg?.qweatherHost || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!key || !host || /^•+/.test(key) || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  return { key, host };
}

/** 和风的天气图标代码 → Open-Meteo 的天气代码（首页图标、出行提醒沿用同一套判断） */
export function qweatherCode(icon) {
  const n = Number(icon);
  if (n === 100 || n === 150) return 0;
  if ([101, 102, 103, 151, 152, 153].includes(n)) return 2;
  if (n === 104 || n === 154) return 3;
  if (n >= 302 && n <= 304) return 95;
  if ([307, 308, 310, 311, 312, 316, 317, 318].includes(n)) return 65;
  if (n >= 300 && n < 400) return 61;
  if (n >= 400 && n < 500) return 71;
  if (n >= 500 && n < 600) return 45;
  return 2;
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const loc = (lat, lon) => `${Number(lon).toFixed(2)},${Number(lat).toFixed(2)}`;

/**
 * 按经纬度一次取全。单项失败（如空气质量、预警不在套餐里）不影响其余；实况都拿不到才算失败
 * @returns {Promise<object>} 原始结果包（交给 parseQWeather）
 */
export async function fetchQWeather({ key, host, latitude, longitude, fetchImpl = (...a) => fetch(...a), signal, timeoutMs = 8000 }) {
  const base = `https://${host}`;
  const at = loc(latitude, longitude);
  const lat = Number(latitude).toFixed(2), lon = Number(longitude).toFixed(2);
  const get = async (path) => {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, { signal: ctrl.signal, headers: { 'X-QW-Api-Key': key, Accept: 'application/json' } });
      if (!res.ok) throw Object.assign(new Error(`和风天气返回 ${res.status}`), { status: res.status });
      const j = await res.json();
      // v7 接口用 code 表示结果（200 正常）；新版接口没有 code
      if (j?.code && String(j.code) !== '200') throw Object.assign(new Error(`和风天气返回 ${j.code}`), { status: Number(j.code) });
      return j;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  };
  const tryBoth = async (a, b) => { try { return await get(a); } catch (e) { if (signal?.aborted) throw e; return get(b); } };
  const [now, daily, hourly, air, indices, alerts, minutely] = await Promise.allSettled([
    get(`/v7/weather/now?location=${at}`),
    get(`/v7/weather/7d?location=${at}`),
    get(`/v7/weather/24h?location=${at}`),
    tryBoth(`/airquality/v1/current/${lat}/${lon}`, `/v7/air/now?location=${at}`),
    get(`/v7/indices/1d?type=3,1,5,9,2,8&location=${at}`),
    tryBoth(`/weatheralert/v1/current/${lat}/${lon}`, `/v7/warning/now?location=${at}`),
    get(`/v7/minutely/5m?location=${at}`)
  ]);
  if (now.status !== 'fulfilled') throw now.reason;
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  return { source: 'qweather', now: ok(now), daily: ok(daily), hourly: ok(hourly), air: ok(air), indices: ok(indices), alerts: ok(alerts), minutely: ok(minutely) };
}

/** 城市搜索（和风 GeoAPI）→ 和 Open-Meteo 一样的城市格式 */
export async function lookupQWeatherCity({ key, host, query, fetchImpl = (...a) => fetch(...a), signal }) {
  const res = await fetchImpl(`https://${host}/geo/v2/city/lookup?location=${encodeURIComponent(String(query).trim().slice(0, 80))}&number=8&lang=zh`, { signal, headers: { 'X-QW-Api-Key': key, Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`和风天气返回 ${res.status}`), { status: res.status });
  const j = await res.json();
  if (j?.code && String(j.code) !== '200') return [];
  return (j.location ?? []).map((c) => ({ name: String(c.name || '').slice(0, 80), latitude: num(c.lat), longitude: num(c.lon), ...(/^https:\/\/www\.qweather\.com\//.test(c.fxLink || '') && { link: String(c.fxLink).slice(0, 300) }), region: [c.adm2 !== c.name ? c.adm2 : '', c.adm1, c.country].filter(Boolean).join(' · ').slice(0, 120) })).filter((c) => c.name && c.latitude !== null && c.longitude !== null).slice(0, 8);
}

/** 空气质量：新版（indexes）和旧版（now.aqi）两种返回都认 */
function airOf(air) {
  if (!air) return null;
  const idx = air.indexes?.find((x) => x.code === 'cn-mee') ?? air.indexes?.[0];
  if (idx) return { aqi: num(idx.aqiDisplay ?? idx.aqi), category: idx.category || '', primary: idx.primaryPollutant?.name || '', pm25: num(air.pollutants?.find((p) => p.code === 'pm2p5')?.concentration?.value) };
  if (air.now) return { aqi: num(air.now.aqi), category: air.now.category || '', primary: air.now.primary && air.now.primary !== 'NA' ? air.now.primary : '', pm25: num(air.now.pm2p5) };
  return null;
}
/** 预警：新版（alerts）和旧版（warning）两种返回都认 */
function alertsOf(a) {
  if (!a) return [];
  if (Array.isArray(a.alerts)) return a.alerts.map((x) => ({ title: x.headline || x.eventType?.name || '', text: x.description || '', level: x.color?.code || x.severity || '' }));
  if (Array.isArray(a.warning)) return a.warning.map((x) => ({ title: x.title || x.typeName || '', text: x.text || '', level: x.severityColor || x.level || '' }));
  return [];
}

/**
 * 原始结果包 → 首页用的数据（字段和 Open-Meteo 的 parseWeather 一样，另加 extra 放更多维度）
 */
export function parseQWeather(bundle, now = Date.now()) {
  const n = bundle?.now?.now;
  const temp = num(n?.temp);
  if (!n || temp === null || temp < -120 || temp > 80) throw new Error('天气数据不完整，请稍后刷新');
  const daily = bundle.daily?.daily ?? [];
  const days = daily.slice(0, 7).map((d) => ({
    date: String(d.fxDate).slice(0, 10), low: num(d.tempMin), high: num(d.tempMax), code: qweatherCode(d.iconDay),
    rain: null, text: d.textDay === d.textNight || !d.textNight ? d.textDay : `${d.textDay}转${d.textNight}`,
    wind: d.windDirDay ? `${d.windDirDay} ${d.windScaleDay}级` : '', uv: num(d.uvIndex), precip: num(d.precip), humidity: num(d.humidity),
    sunrise: d.sunrise || '', sunset: d.sunset || ''
  })).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  const obs = String(n.obsTime || '');
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(obs);
  const hour = Number(obs.slice(11, 13));
  const today = days[0];
  const isDay = today?.sunrise && today?.sunset ? obs.slice(11, 16) >= today.sunrise && obs.slice(11, 16) < today.sunset : hour >= 6 && hour < 18;
  return {
    source: 'qweather',
    temp, code: qweatherCode(n.icon), text: n.text || '', isDay,
    at: obs.slice(0, 16), offset: offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3]) * 60) : 28800,
    days, fetchedAt: now,
    extra: {
      feels: num(n.feelsLike), humidity: num(n.humidity), wind: n.windDir ? `${n.windDir} ${n.windScale}级（${n.windSpeed} km/h）` : '',
      pressure: num(n.pressure), vis: num(n.vis), precip: num(n.precip), cloud: num(n.cloud), dew: num(n.dew),
      air: airOf(bundle.air),
      hourly: (bundle.hourly?.hourly ?? []).slice(0, 24).map((h) => ({ time: String(h.fxTime).slice(11, 16), temp: num(h.temp), text: h.text || '', code: qweatherCode(h.icon), pop: num(h.pop) })),
      indices: (bundle.indices?.daily ?? []).map((x) => ({ name: x.name || '', category: x.category || '', text: x.text || '' })).filter((x) => x.name),
      alerts: alertsOf(bundle.alerts).filter((x) => x.title),
      rainSoon: bundle.minutely?.summary || ''
    }
  };
}

/** 给模型看的文字版（对话里问天气时） */
export function formatQWeather(placeName, data, days = 3, link = '') {
  const x = data.extra ?? {};
  const lines = [`地点：${placeName}`];
  lines.push(`实况（${data.at.replace('T', ' ')}）：${data.text}，${Math.round(data.temp)}°C${x.feels !== null ? `（体感 ${Math.round(x.feels)}°C）` : ''}${x.humidity !== null ? `，湿度 ${x.humidity}%` : ''}${x.wind ? `，${x.wind}` : ''}${x.pressure !== null ? `，气压 ${x.pressure} hPa` : ''}${x.vis !== null ? `，能见度 ${x.vis} km` : ''}${x.precip ? `，降水 ${x.precip} mm` : ''}`);
  if (x.rainSoon) lines.push(`未来两小时：${x.rainSoon}`);
  if (x.air?.aqi !== null && x.air) lines.push(`空气质量：AQI ${x.air.aqi}（${x.air.category}）${x.air.primary ? `，首要污染物 ${x.air.primary}` : ''}`);
  for (const a of x.alerts ?? []) lines.push(`预警：${a.title}${a.text ? `。${a.text.slice(0, 120)}` : ''}`);
  const next = (x.hourly ?? []).slice(0, 12).filter((_, i) => i % 3 === 0);
  if (next.length) lines.push(`接下来几小时：${next.map((h) => `${h.time} ${h.text} ${h.temp}°C${h.pop !== null ? ` 降水 ${h.pop}%` : ''}`).join('；')}`);
  const NAMES = ['今天', '明天', '后天'];
  data.days.slice(0, days).forEach((d, i) => lines.push(`${NAMES[i] ?? d.date}（${d.date}）：${d.text}，${d.low}～${d.high}°C${d.wind ? `，${d.wind}` : ''}${d.uv !== null ? `，紫外线 ${d.uv}` : ''}${d.sunrise ? `，日出 ${d.sunrise} 日落 ${d.sunset}` : ''}`));
  if (x.indices?.length) lines.push(`生活指数：${x.indices.map((i) => `${i.name} ${i.category}`).join('；')}`);
  lines.push('来源：和风天气（qweather.com）');
  // 这个城市在和风天气网站上的预报页（查城市时接口给的 fxLink）：回答引用来源时给这个，用户点开能看到同一份预报
  if (link) lines.push(`本次数据链接（引用来源时给这个，不要只给首页）：${link}`);
  return lines.join('\n');
}
