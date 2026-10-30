import { weatherKind, weatherAdvice } from '../core/weather.js';

const element = (tag, text, className = '') => Object.assign(document.createElement(tag), { textContent: text, className });
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
const degrees = (v) => (numeric(v) ? `${Math.round(v)}°` : '—');

/** 所有显示值只取已取得的数据；缺测不写成零，缓存不冒充实时。 */
export function weatherOverview(data, { stale = false } = {}) {
  if (!data) return '查看天气';
  const day = data.days?.[0];
  const range = numeric(day?.low) && numeric(day?.high) ? ` ${degrees(day.low)} / ${degrees(day.high)}` : '';
  return `${stale ? '缓存 · ' : ''}${data.text || weatherKind(data.code).label}${range}`;
}

/** 有预警时先提醒查看预警，不能同时说天气不错；过期数据沿用缓存提示。 */
export function weatherTravelAdvice(data, { stale = false } = {}) {
  if (!stale && data?.extra?.alerts?.some((alert) => alert.title)) return '当地有气象预警，出门前先查看预警详情。';
  return weatherAdvice(data, { stale });
}

export function weatherMetrics(data) {
  const x = data?.extra || {},
    day = data?.days?.[0],
    rows = [];
  const add = (label, value, unit = '') => {
    if (numeric(value)) rows.push([label, `${value}${unit}`]);
  };
  add('体感温度', x.feels, '°');
  add('相对湿度', x.humidity, '%');
  if (x.wind) rows.push(['风向风力', x.wind.replace(/（.*$/, '')]);
  if (numeric(x.air?.aqi)) rows.push(['空气质量', `${x.air.aqi}${x.air.category ? ' · ' + x.air.category : ''}`]);
  add('紫外线指数', day?.uv);
  add('能见度', x.vis, ' km');
  add('气压', x.pressure, ' hPa');
  add('近1小时降水', x.precip, ' mm');
  if (day?.sunrise && day?.sunset) rows.push(['日出 / 日落', `${day.sunrise} / ${day.sunset}`]);
  return rows;
}

function weatherIcon(svg, code, night = false, className = '') {
  const icon = element('span', '', className);
  // SVG仅来自固定图标字典，天气服务的文本只用textContent。
  icon.innerHTML = svg(weatherKind(code).icon, night);
  return icon;
}

function renderCurrent(root, state, svg) {
  const { city, data, status: weatherStatus, stale, error } = state;
  const current = root.querySelector('.weather-current');
  const copy = element('div', '', 'weather-current-copy');
  copy.append(element('strong', city?.name || '尚未选择城市'));
  copy.append(element('b', data ? degrees(data.temp) : '—', 'weather-current-temperature'));
  copy.append(element('span', data ? weatherOverview(data, { stale }) : weatherStatus === 'loading' ? '正在获取天气…' : error || '请选择城市'));
  current.replaceChildren(copy, weatherIcon(svg, data?.code, data && !data.isDay, 'weather-current-icon'));
  const advice = root.querySelector('.weather-detail-advice');
  advice.replaceChildren(element('b', '出门提醒'), element('span', data ? state.advice : '选择城市后，看看今天该穿什么、出门要不要带伞。'));
  if (data?.extra?.rainSoon) advice.append(element('small', data.extra.rainSoon));
}

function renderAlerts(root, data) {
  const container = root.querySelector('.weather-alerts');
  container.replaceChildren();
  for (const alert of (data?.extra?.alerts || []).slice(0, 6)) {
    const item = element('details', '', 'weather-alert');
    item.append(element('summary', alert.title), element('p', alert.text || '请留意当地气象台的最新预警。'));
    container.append(item);
  }
}

function renderMetrics(root, data) {
  const grid = root.querySelector('.weather-extra');
  grid.replaceChildren();
  for (const [label, value] of weatherMetrics(data)) {
    const cell = element('div', '', 'weather-metric');
    cell.append(element('small', label), element('b', value));
    grid.append(cell);
  }
  root.querySelector('.weather-metrics-section').hidden = !grid.childElementCount;
}

function renderForecast(root, data, svg) {
  const hours = root.querySelector('.weather-hours'),
    days = root.querySelector('.weather-days');
  hours.replaceChildren();
  days.replaceChildren();
  for (const hour of (data?.extra?.hourly || []).slice(0, 24)) {
    const item = element('div', '', 'weather-hour');
    const pop = numeric(hour.pop) ? `降水 ${hour.pop}%` : '';
    item.append(
      element('small', hour.time),
      weatherIcon(svg, hour.code),
      element('b', degrees(hour.temp)),
      element('span', hour.text || weatherKind(hour.code).label),
      element('small', pop)
    );
    hours.append(item);
  }
  const localDate = new Date(Date.now() + (data?.offset || 0) * 1000).toISOString().slice(0, 10);
  for (const day of (data?.days || []).slice(0, 7)) {
    const item = element('div', '', 'weather-day');
    // 用气象资料当地日期比对，跨日/缓存时不把昨天误标为今天。
    const dayOffset = (Date.parse(day.date) - Date.parse(localDate)) / 86400000;
    const dateLabel = dayOffset === 0 ? '今天' : dayOffset === 1 ? '明天' : day.date.slice(5).replace('-', '/');
    item.append(
      element('b', dateLabel),
      weatherIcon(svg, day.code),
      element('span', day.text || weatherKind(day.code).label),
      element('strong', `${degrees(day.low)} / ${degrees(day.high)}`),
      element('small', numeric(day.rain) ? `降雨概率 ${day.rain}%` : day.wind || '')
    );
    days.append(item);
  }
  root.querySelector('.weather-hours-section').hidden = !hours.childElementCount;
  root.querySelector('.weather-days-section').hidden = !days.childElementCount;
  root.querySelector('.weather-days-heading').textContent = `未来 ${days.childElementCount} 天天气`;
}

function renderLife(root, data) {
  const container = root.querySelector('.weather-indices');
  container.replaceChildren();
  // 和风已给出文字建议，直接展示；手机不再依赖悬浮title才能读到。
  for (const index of (data?.extra?.indices || []).slice(0, 8)) {
    const item = element('article', '', 'weather-index');
    const header = element('div', '', 'weather-index-title');
    header.append(element('small', index.name.replace(/指数$/, '')), element('b', index.category || ''));
    item.append(header);
    if (index.text) item.append(element('p', index.text));
    container.append(item);
  }
  root.querySelector('.weather-life-section').hidden = !container.childElementCount;
}

export function renderWeatherDetails(root, state, svg) {
  renderCurrent(root, state, svg);
  renderAlerts(root, state.data);
  renderMetrics(root, state.data);
  renderForecast(root, state.data, svg);
  renderLife(root, state.data);
  const source = root.querySelector('.weather-source');
  source.replaceChildren();
  if (!state.data) return;
  const isQWeather = state.data.source === 'qweather';
  const link = element('a', isQWeather ? '和风天气' : 'Open-Meteo');
  link.href = isQWeather ? 'https://www.qweather.com/' : 'https://open-meteo.com/';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  source.append('天气数据来自 ', link);
  if (!isQWeather) source.append(' · 当前来源未提供生活指数');
}
