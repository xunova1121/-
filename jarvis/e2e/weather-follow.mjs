/** 真实手机版UI的前台跟随回归；天气/系统定位为固定模拟，不冒充安卓真机。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-weather-follow');
await fs.mkdir(output, { recursive: true });
const root = path.resolve('dist-mobile');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm'
};
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const here = { name: '南京市 · 江宁区', city: '南京市', district: '江宁区', latitude: 31.95, longitude: 118.84, source: 'location' };
const moved = { latitude: 31.96, longitude: 118.84 };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log('✓ ' + message);
}
async function scene({ city = here, granted = true, holdWeather = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (granted) await ctx.grantPermissions(['geolocation'], { origin: base });
  await ctx.setGeolocation(here);
  await ctx.addInitScript(
    ({ city }) => {
      const realNow = Date.now.bind(Date);
      globalThis.__weatherOffset = 0;
      Date.now = () => realNow() + globalThis.__weatherOffset;
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false }));
      localStorage.setItem('jarvis.weather.locationAsked.v1', '1');
      localStorage.setItem('jarvis.weather.city.v1', JSON.stringify(city));
      const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      localStorage.setItem(
        'jarvis.weather.cache.v1',
        JSON.stringify({
          key: `${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}`,
          data: {
            source: 'open-meteo',
            temp: 20,
            code: 0,
            isDay: true,
            at: date + 'T12:00',
            offset: 28800,
            days: [{ date, low: 10, high: 25, code: 0, rain: 0 }],
            fetchedAt: Date.now()
          }
        })
      );
      globalThis.__weatherGeoCalls = [];
      globalThis.__weatherGeoDelivered = 0;
      globalThis.__weatherFixes = [];
      globalThis.__holdWeatherGeo = false;
      const get = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition = (success, error, options) => {
        if (__weatherGeoCalls.length < 16) __weatherGeoCalls.push(options);
        return get(
          (p) => {
            if (__holdWeatherGeo && __weatherFixes.length < 2)
              __weatherFixes.push(() => {
                __weatherGeoDelivered++;
                success(p);
              });
            else {
              __weatherGeoDelivered++;
              success(p);
            }
          },
          error,
          options
        );
      };
      globalThis.__releaseWeatherGeo = () => {
        const rows = __weatherFixes.splice(0);
        __holdWeatherGeo = false;
        for (const run of rows) run();
      };
    },
    { city }
  );
  const calls = [];
  let held;
  await ctx.route('https://api.open-meteo.com/**', async (route) => {
    const lat = new URL(route.request().url()).searchParams.get('latitude');
    calls.push(lat);
    if (holdWeather && lat === '31.96') {
      held = route;
      return;
    }
    const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10),
      temp = lat === '31.96' ? 26 : lat === '39.9' ? 18 : 20;
    return route.fulfill({
      json: {
        utc_offset_seconds: 28800,
        current: { temperature_2m: temp, weather_code: 0, is_day: 1, time: date + 'T12:00' },
        daily: { time: [date], temperature_2m_min: [10], temperature_2m_max: [27], weather_code: [0], precipitation_probability_max: [0] }
      }
    });
  });
  const page = await ctx.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#homepage-weather');
  if (granted && city.source === 'location') await page.waitForFunction(() => __weatherGeoDelivered >= 1);
  await page.waitForTimeout(120);
  return { ctx, page, calls, errors, held: () => held };
}
async function resume(page) {
  await page.evaluate(() => {
    __weatherOffset += 11000;
    globalThis.__jarvisForeground = true;
    dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: true } }));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
try {
  {
    const s = await scene();
    const before = await s.page.evaluate(() => __weatherGeoCalls.length);
    await s.ctx.setGeolocation(moved);
    await resume(s.page);
    await s.page.waitForFunction(() => document.querySelector('.home-weather-temp')?.textContent === '26°');
    check(
      await s.page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.weather.city.v1')).latitude === 31.96),
      '安卓回前台事件使不足2公里的移动更新位置'
    );
    check(await s.page.evaluate((n) => __weatherGeoCalls.length === n + 1, before), '原生前台和网页可见事件只触发一次定位');
    check(await s.page.evaluate(() => __weatherGeoCalls.at(-1).maximumAge === 0), '回前台请求新位置，不复用10分钟旧定位');
    check(s.errors.length === 0, '移动场景没有页面错误');
    await s.page.screenshot({ path: path.join(output, 'foreground-relocated.png') });
    await s.ctx.close();
  }
  {
    const s = await scene({ city: { ...here, source: undefined } });
    await s.ctx.setGeolocation(moved);
    await resume(s.page);
    await s.page.locator('.home-weather-details').click();
    await s.page.locator('.weather-refresh').click();
    check(await s.page.evaluate(() => __weatherGeoCalls.length === 0), '手选城市即使回前台或刷新天气也不被自动定位改掉');
    check(s.errors.length === 0, '手选场景没有页面错误');
    await s.ctx.close();
  }
  {
    const s = await scene({ granted: false });
    await s.page.waitForFunction(() => document.querySelector('.home-weather-summary')?.textContent.includes('位置待更新'));
    await s.page.locator('.home-weather-details').click();
    check(await s.page.evaluate(() => __weatherGeoCalls.length === 0), '未授权时不调用定位或弹系统授权');
    check((await s.page.locator('.weather-provider-note').textContent()).includes('授权'), '详情说明定位授权未取得，而不是静默保留旧地点');
    check(s.errors.length === 0, '未授权场景没有页面错误');
    await s.ctx.close();
  }
  {
    const s = await scene({ holdWeather: true });
    await s.ctx.setGeolocation(moved);
    await resume(s.page);
    for (let i = 0; i < 100 && !s.held(); i++) await s.page.waitForTimeout(50);
    check(!!s.held(), '实际请求了新坐标天气');
    check(
      await s.page.evaluate(
        () => document.querySelector('.home-city b').textContent === '江宁区' && document.querySelector('.home-weather-temp').textContent === '20°'
      ),
      '新天气请求期间旧地点和旧温度成对保留'
    );
    await s.held().abort();
    await s.page.waitForFunction(() => document.querySelector('.home-weather-summary')?.textContent.includes('位置待更新'));
    check(
      await s.page.evaluate(
        () => document.querySelector('.home-city b').textContent === '江宁区' && document.querySelector('.home-weather-temp').textContent === '20°'
      ),
      '新位置天气失败仍保留旧地点与温度，并明确标位置待更新'
    );
    check(s.errors.length === 0, '新位置取数失败场景没有页面错误');
    await s.page.screenshot({ path: path.join(output, 'relocation-failed-notice.png') });
    await s.ctx.close();
  }
  {
    const s = await scene();
    await s.page.evaluate(() => {
      __holdWeatherGeo = true;
    });
    await s.ctx.setGeolocation(moved);
    await resume(s.page);
    await s.page.waitForFunction(() => __weatherFixes.length > 0);
    await s.page.locator('.home-weather-location').click();
    await s.page.locator('.weather-city-result').filter({ hasText: '北京' }).click();
    await s.page.waitForFunction(
      () => document.querySelector('.home-city b')?.textContent === '北京' && document.querySelector('.home-weather-temp')?.textContent === '18°'
    );
    await s.page.evaluate(() => __releaseWeatherGeo());
    await s.page.waitForTimeout(150);
    check(await s.page.evaluate(() => document.querySelector('.home-city b').textContent === '北京'), '迟到的自动定位不能覆盖用户手选城市');
    check(!s.calls.includes('31.96'), '手选后旧定位结果不会再查询另一地点天气');
    check(s.errors.length === 0, '迟到定位场景没有页面错误');
    await s.ctx.close();
  }
  console.log(`\n${checks}/${checks} 通过；固定模拟位置/天气，不是安卓真机定位验收。`);
} finally {
  await browser.close();
  server.close();
}
