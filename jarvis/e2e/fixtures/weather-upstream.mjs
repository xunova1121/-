/** 仅供隔离端到端进程预加载；真实服务器/认证/浏览器照常运行，上游为虚构天气。 */
export function installWeatherFixture() {
  const actual = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const address = new URL(url);
    if (address.hostname === 'api.open-meteo.com') {
      const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      return Response.json({ utc_offset_seconds: 28800, current: { temperature_2m: 18, weather_code: 0, is_day: 1, time: date + 'T12:00' }, daily: { time: [date], temperature_2m_min: [12], temperature_2m_max: [22], weather_code: [0], precipitation_probability_max: [0] } });
    }
    if (address.hostname !== 'fixture.re.qweatherapi.com') return actual(url, init);
    if (init.headers['X-QW-Api-Key'] !== 'server-weather-fixture') return Response.json({}, { status: 401 });
    const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    const p = address.pathname;
    let body = {};
    if (p.includes('/city/lookup')) body = { location: [{ name: '鼓楼区', adm2: '南京市', adm1: '江苏省', country: '中国', lat: '32.06', lon: '118.80' }] };
    else if (p === '/v7/weather/now') body = { now: { temp: '21', text: '多云', icon: '101', feelsLike: '20', humidity: '63', pressure: '1016', vis: '20', windDir: '东北风', windScale: '2', windSpeed: '8', precip: '0', obsTime: date + 'T12:00+08:00' } };
    else if (p === '/v7/weather/7d') body = { daily: Array.from({ length: 7 }, (_, i) => ({ fxDate: new Date(Date.parse(date) + i * 86400000).toISOString().slice(0, 10), tempMin: '14', tempMax: '22', iconDay: '101', textDay: '多云' })) };
    else if (p === '/v7/weather/24h') body = { hourly: Array.from({ length: 24 }, (_, i) => ({ fxTime: date + 'T' + String(i).padStart(2, '0') + ':00+08:00', temp: '21', icon: '101', text: '多云', pop: '0' })) };
    else if (p.includes('/indices/')) body = { daily: [{ name: '穿衣指数', category: '舒适', text: '早晚温差较大，建议带一件薄外套。' }] };
    else if (p.includes('/airquality/')) body = { indexes: [{ code: 'cn-mee', aqiDisplay: '38', category: '优' }] };
    return Response.json({ code: '200', ...body });
  };
}
