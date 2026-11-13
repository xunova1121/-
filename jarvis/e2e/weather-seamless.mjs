/**
 * 首页天气无感刷新与定位（用户 2026-11-01）。先 npm run build:mobile，再执行
 *   node e2e/weather-seamless.mjs [截图输出目录]
 * 固定虚构天气，不调用真实接口：
 * 1. 缓存过了 15 分钟、后台刷新慢：刷新期间照常显示旧天气，不出现“缓存”“正在看看天气”；刷新完换新数据。
 * 2. 城市来自定位、已授权定位、人从南京到了上海：打开首页后不弹框，自动换成上海。
 * 3. 没授权定位：不弹授权、不定位，城市不变。
 * 4. 已授权但新位置的天气取不到：留在原来的城市和天气，不报错。
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-weather-seamless');
await fs.mkdir(output, { recursive: true });
const root = path.resolve('dist-mobile');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    const bytes = await fs.readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};
const NANJING = { name: '当前位置', latitude: 32.06, longitude: 118.8, source: 'location' };
const SHANGHAI = { latitude: 31.23, longitude: 121.47 };

async function scene({ city, ageMinutes = 1, granted = false, geo, delay = 0, failFor = null }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (granted) await ctx.grantPermissions(['geolocation'], { origin: base });
  if (geo) await ctx.setGeolocation(geo);
  await ctx.addInitScript(({ city, ageMinutes }) => {
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false }));
    localStorage.setItem('jarvis.weather.locationAsked.v1', '1');
    const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    const days = [{ date, low: 14, high: 22, code: 2, rain: 10 }];
    const data = { source: 'open-meteo', temp: 21, code: 2, isDay: true, at: date + 'T10:00', offset: 28800, days, fetchedAt: Date.now() - ageMinutes * 60000 };
    localStorage.setItem('jarvis.weather.city.v1', JSON.stringify(city));
    localStorage.setItem('jarvis.weather.cache.v1', JSON.stringify({ key: `${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}`, data }));
  }, { city, ageMinutes });
  const weatherCalls = [];
  await ctx.route('https://api.open-meteo.com/**', async (route) => {
    const url = new URL(route.request().url());
    weatherCalls.push(url.searchParams.get('latitude'));
    if (failFor && url.searchParams.get('latitude') === failFor) return route.abort();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    const temp = url.searchParams.get('latitude') === '31.23' ? 26 : 18;
    return route.fulfill({ json: { utc_offset_seconds: 28800, current: { temperature_2m: temp, weather_code: 0, is_day: 1, time: date + 'T11:00' }, daily: { time: [date], temperature_2m_min: [15], temperature_2m_max: [27], weather_code: [0], precipitation_probability_max: [0] } } });
  });
  const page = await ctx.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__jarvis && document.querySelector('#homepage-weather .home-weather-temp'));
  return { ctx, page, errors, weatherCalls };
}
const text = (page, s) => page.locator(s).first().textContent();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // 1. 后台刷新慢
  {
    const { ctx, page, errors } = await scene({ city: { name: '南京', latitude: 32.06, longitude: 118.8 }, ageMinutes: 20, delay: 2500 });
    const during = { temp: await text(page, '.home-weather-temp'), summary: await text(page, '.home-weather-summary'), updated: await text(page, '.weather-updated') };
    check('后台刷新期间照常显示旧温度', during.temp === '21°', JSON.stringify(during));
    check('后台刷新期间不出现“缓存”“正在看看天气”', !/缓存|正在看看天气/.test(during.summary + during.updated), JSON.stringify(during));
    await page.waitForFunction(() => document.querySelector('.home-weather-temp')?.textContent === '18°', null, { timeout: 15000 });
    check('刷新完换成新温度、仍没有“缓存”', !/缓存/.test((await text(page, '.home-weather-summary')) + (await text(page, '.weather-updated'))));
    check('场景1 无页面错误', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // 2. 已授权、换了城市
  {
    const { ctx, page, errors, weatherCalls } = await scene({ city: NANJING, granted: true, geo: SHANGHAI });
    await page.waitForFunction(() => document.querySelector('.home-city b')?.textContent === '上海', null, { timeout: 15000 }).catch(() => {});
    check('已授权定位：自动换成新位置“上海”', (await text(page, '.home-city b')) === '上海', `${await text(page, '.home-city b')} calls=${weatherCalls.join(',')}`);
    check('换位置后显示新位置天气', (await text(page, '.home-weather-temp')) === '26°');
    check('自动换位置不弹窗', !(await page.locator('#homepage-weather-dialog').evaluate((d) => d.open)));
    check('新位置已记住', await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.weather.city.v1')).latitude === 31.23));
    await page.screenshot({ path: path.join(output, 'weather-seamless-relocated.png') });
    check('场景2 无页面错误', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // 3. 没授权
  {
    const { ctx, page, errors, weatherCalls } = await scene({ city: NANJING, granted: false, geo: SHANGHAI });
    await page.waitForTimeout(2500);
    check('没授权定位：不换城市、不查新位置', !weatherCalls.includes('31.23') && (await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.weather.city.v1')).latitude === 32.06)), weatherCalls.join(','));
    check('场景3 无页面错误', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // 4. 新位置天气取不到
  {
    const { ctx, page, errors, weatherCalls } = await scene({ city: NANJING, granted: true, geo: SHANGHAI, failFor: '31.23' });
    for (let i = 0; i < 30 && !weatherCalls.includes('31.23'); i++) await page.waitForTimeout(200);
    await page.waitForTimeout(800);
    const shown = { temp: await text(page, '.home-weather-temp'), summary: await text(page, '.home-weather-summary'), updated: await text(page, '.weather-updated') };
    check('新位置取不到：试过新位置', weatherCalls.includes('31.23'), weatherCalls.join(','));
    check('新位置取不到：留在原来的天气，不报错、不标缓存', shown.temp === '21°' && !/缓存|暂不可用|连不上/.test(shown.summary + shown.updated), JSON.stringify(shown));
    check('新位置取不到：记住的城市不变', await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.weather.city.v1')).latitude === 32.06));
    check('场景4 无页面错误', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
