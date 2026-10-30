import { renderWeatherDetails, weatherOverview, weatherTravelAdvice } from './weatherDetails.js';
import './weatherCard.css';
import { POPULAR_CITIES, weatherKind, cityKey } from '../core/weather.js';

export function weatherSVG(kind = 'sun', night = false) {
  const paths = {
    sun: night
      ? '<path d="M19 15A8 8 0 0 1 9 5a8 8 0 1 0 10 10z"/>'
      : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
    cloud: '<path d="M6 18a4 4 0 0 1-.5-8A6 6 0 0 1 17 8a5 5 0 0 1 1 10z"/>',
    rain: '<path d="M6 15a4 4 0 0 1-.5-8A6 6 0 0 1 17 7a4 4 0 0 1 1 8M8 18l-1 3m6-3-1 3m6-3-1 3"/>',
    snow: '<path d="M6 14a4 4 0 0 1-.5-7A6 6 0 0 1 17 7a4 4 0 0 1 1 7M8 17v5m-2.2-3.8 4.4 2.6m-4.4 0 4.4-2.6M17 17v5m-2.2-3.8 4.4 2.6m-4.4 0 4.4-2.6"/>',
    storm: '<path d="M6 15a4 4 0 0 1-.5-8A6 6 0 0 1 17 7a4 4 0 0 1 1 8M13 13l-4 6h5l-3 4"/>',
    fog: '<path d="M6 12a4 4 0 0 1-.5-7A6 6 0 0 1 17 5a4 4 0 0 1 1 7M4 16h16M6 20h12"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.cloud}</svg>`;
}
const node = (tag, text, className) =>
  Object.assign(document.createElement(tag), { ...(text !== undefined ? { textContent: text } : {}), ...(className ? { className } : {}) });
const degrees = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}°` : '—');
export async function locateWeatherCity() {
  if (globalThis.Capacitor?.isNativePlatform?.()) {
    const { registerPlugin } = await import('@capacitor/core');
    const p = await registerPlugin('WeatherLocation').locate();
    return { name: p.name || '附近', latitude: p.latitude, longitude: p.longitude, source: 'location' };
  }
  if (!navigator.geolocation) throw new Error('当前环境不支持定位，请手动选城市');
  const p = await new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 })
  ).catch((error) => {
    throw new Error(error.code === 1 ? '定位未允许，可以手动选择城市' : '暂时没有定位结果，可以手动选择城市');
  });
  const lat = p.coords.latitude,
    lon = p.coords.longitude,
    city = POPULAR_CITIES.find((c) => Math.hypot(c.latitude - lat, (c.longitude - lon) * Math.cos((lat * Math.PI) / 180)) < 0.3);
  return { name: city?.name || '附近', latitude: Math.round(lat * 100) / 100, longitude: Math.round(lon * 100) / 100, source: 'location' };
}

let sessionLocation;
const locateOnce = () => (sessionLocation ??= locateWeatherCity());
export function createHomeWeather({ client, onAdvice, locate = locateOnce } = {}) {
  const root = node('section', undefined, 'home-weather');
  root.id = 'homepage-weather';
  root.setAttribute('aria-label', '日期与天气');
  root.innerHTML =
    '<div class="home-weather-top"><span class="home-date"></span><div class="home-city"><button type="button" class="home-weather-details" aria-label="查看天气详情"><span class="home-weather-icon"></span><span class="home-weather-place"><b>选择城市</b><small class="home-weather-condition">查看天气</small></span><strong class="home-weather-temp">—</strong></button><button type="button" class="home-weather-location" aria-label="切换天气位置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button></div></div><div class="home-weather-bottom"><span class="home-weather-summary" role="status">选个城市，看看出门的天气</span></div>';
  root.querySelector('.home-date').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' })
    .format(new Date())
    .replace('日', '日 · ');
  const dialog = node('dialog', undefined, 'weather-dialog');
  dialog.id = 'homepage-weather-dialog';
  dialog.setAttribute('aria-labelledby', 'weather-dialog-title');
  dialog.innerHTML =
    '<header><h2 id="weather-dialog-title">选择城市</h2><button type="button" class="weather-close" aria-label="关闭天气">×</button></header><div class="weather-city-view"><p class="weather-privacy">选择城市即可查看天气；使用定位时只查询约公里级位置，不持续定位。</p><form class="weather-search"><input aria-label="搜索天气城市" placeholder="输入城市名，如杭州" maxlength="80"><button type="submit">搜索</button></form><button type="button" class="weather-locate">⌖ 使用当前位置</button><p class="weather-message" role="status"></p><div class="weather-city-results"></div><button type="button" class="weather-clear">关闭首页天气</button><p class="weather-attribution">城市检索数据：<a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a></p></div><div class="weather-detail-view" hidden><div class="weather-current"></div><div class="weather-alerts"></div><p class="weather-detail-advice"></p><section class="weather-metrics-section"><h3>天气详情</h3><div class="weather-extra"></div></section><section class="weather-hours-section"><h3>逐小时预报 <small>左右滑动查看</small></h3><div class="weather-hours"></div></section><section class="weather-days-section"><h3 class="weather-days-heading">未来天气</h3><div class="weather-days"></div></section><section class="weather-life-section"><h3>生活建议 <small>和风生活指数</small></h3><div class="weather-indices"></div></section><p class="weather-updated"></p><div class="weather-detail-actions"><button type="button" class="weather-change">切换城市</button><button type="button" class="weather-refresh">刷新天气</button></div><p class="weather-attribution weather-source">天气数据：<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> · 预报仅供出行参考</p></div>';
  document.body.append(dialog);
  const $ = (s) => dialog.querySelector(s),
    results = $('.weather-city-results');
  let searchCtrl,
    searchId = 0,
    locationId = 0,
    previousFocus;
  const showCities = (rows) => {
    results.replaceChildren();
    for (const city of rows) {
      const b = node('button', undefined, 'weather-city-result');
      b.type = 'button';
      b.append(node('b', city.name), node('span', city.region || '中国'));
      b.onclick = () => {
        dialog.close();
        client.select(city).catch((error) => {
          $('.weather-message').textContent = error.message;
        });
      };
      results.append(b);
    }
  };
  function open(mode) {
    if (!dialog.open) previousFocus = document.activeElement;
    $('.weather-city-view').hidden = mode !== 'city';
    $('.weather-detail-view').hidden = mode === 'city';
    $('#weather-dialog-title').textContent = mode === 'city' ? '选择城市' : '天气与出行';
    if (mode === 'city') {
      showCities(POPULAR_CITIES);
      $('.weather-message').textContent = '常用城市';
    }
    if (!dialog.open) dialog.showModal();
  }
  root.querySelector('.home-weather-location').onclick = () => open('city');
  root.querySelector('.home-weather-details').onclick = () => open(client.state.city ? 'detail' : 'city');
  $('.weather-close').onclick = () => dialog.close();
  $('.weather-change').onclick = () => open('city');
  $('.weather-clear').onclick = () => {
    client.clear();
    dialog.close();
  };
  $('.weather-refresh').onclick = async () => {
    const b = $('.weather-refresh');
    b.disabled = true;
    try {
      await client.refresh({ force: true });
    } finally {
      b.disabled = false;
    }
  };
  $('.weather-search').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('input').value.trim();
    if (q.length < 2) {
      $('.weather-message').textContent = '请输入至少两个字的城市名';
      return;
    }
    searchCtrl?.abort();
    searchCtrl = new AbortController();
    const id = ++searchId;
    $('.weather-message').textContent = '正在找城市…';
    try {
      const rows = await client.search(q, searchCtrl.signal);
      if (id !== searchId) return;
      showCities(rows);
      $('.weather-message').textContent = rows.length ? '选择对应的城市' : '暂未找到，可以输入完整城市名再试';
    } catch {
      if (id === searchId) $('.weather-message').textContent = '城市搜索暂不可用，可选择常用城市或稍后重试';
    }
  };
  $('.weather-locate').onclick = async () => {
    const b = $('.weather-locate'),
      id = ++locationId;
    b.disabled = true;
    $('.weather-message').textContent = '正在获取位置…';
    try {
      const city = await (locate === locateOnce ? locateWeatherCity() : locate());
      if (id !== locationId || !dialog.open) return;
      dialog.close();
      await client.select(city);
    } catch (error) {
      if (id === locationId) $('.weather-message').textContent = error.message || '无法定位，请手动选城市';
    } finally {
      b.disabled = false;
    }
  };
  dialog.addEventListener('close', () => {
    searchId++;
    locationId++;
    searchCtrl?.abort();
    previousFocus?.focus({ preventScroll: true });
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.stopPropagation();
  });
  const unsubscribe = client.subscribe((state) => {
    const { city, data, status, stale, error } = state,
      kind = weatherKind(data?.code);
    root.querySelector('.home-city b').textContent = city ? city.name.replace(/市$/, '') : '选择城市';
    root.querySelector('.home-weather-temp').textContent = data ? degrees(data.temp) : '—';
    root.querySelector('.home-weather-condition').textContent = weatherOverview(data, { stale });
    root.querySelector('.home-weather-details').setAttribute('aria-label', city ? `查看${city.name}天气详情${data ? '，' + degrees(data.temp) : ''}` : '查看天气详情');
    root.querySelector('.home-weather-location').setAttribute('aria-label', city ? `切换天气位置，当前${city.name}` : '切换天气位置');
    root.querySelector('.home-weather-icon').innerHTML = weatherSVG(data ? kind.icon : 'cloud', data && !data.isDay);
    root.querySelector('.home-weather-summary').textContent = data
      ? `${stale ? '缓存 · ' : ''}${weatherTravelAdvice(data, { stale })}`
      : status === 'loading'
        ? '正在看看天气…'
        : error
          ? '天气暂不可用，点击重试'
          : '选个城市，看看出门的天气';
    const advice = weatherTravelAdvice(data, { stale });
    onAdvice?.(advice);
    renderWeatherDetails(dialog, { city, data, status, stale, error, advice }, weatherSVG);
    $('.weather-updated').textContent = data ? `${stale ? '缓存数据 · ' : ''}资料时间 ${data.at.replace('T', ' ')}${error ? ' · 暂未更新' : ''}` : error;
  });
  let autoCancelled = false;
  // 只在第一次打开首页时定位一次；之后用记住的城市，不再每次打开都弹定位确认。要更新位置点“使用当前位置”。
  let attempted = false;
  try {
    attempted = localStorage.getItem('jarvis.weather.locationAsked.v1') === '1';
  } catch {
    attempted = true;
  }
  const originalCity = client.state.city,
    originalKey = originalCity ? cityKey(originalCity) : '';
  if (!originalCity && !attempted) {
    try {
      localStorage.setItem('jarvis.weather.locationAsked.v1', '1');
    } catch {}
    locate()
      .then((city) => {
        const current = client.state.city;
        if (!autoCancelled && ((!originalCity && !current) || (current?.source === 'location' && cityKey(current) === originalKey))) return client.select(city);
      })
      .catch(() => {
        if (!autoCancelled && !client.state.city) root.querySelector('.home-weather-summary').textContent = '定位暂不可用，可以手动选城市';
      });
  }
  const foreground = () => {
    if (!document.hidden && root.isConnected) client.refresh();
  };
  document.addEventListener('visibilitychange', foreground);
  client.refresh();
  return {
    root,
    destroy() {
      autoCancelled = true;
      unsubscribe();
      searchId++;
      locationId++;
      searchCtrl?.abort();
      document.removeEventListener('visibilitychange', foreground);
      dialog.remove();
    }
  };
}
