/** 真实App构建的天气交互/窄屏/深色验收；固定虚构天气，不调用真实和风或付费接口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-weather-card');
await fs.mkdir(output, { recursive: true });
const root = path.resolve('dist-mobile');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    const bytes = await fs.readFile(file);
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm'
      }[path.extname(file)] || 'application/octet-stream'
    );
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [];
let activePage;
const check = (label, value, detail) => {
  checks.push({ label, ok: value, ...(detail ? { detail } : {}) });
  assert.equal(value, true, detail ? `${label}: ${JSON.stringify(detail)}` : label);
};
try {
  for (const [width, theme, fontFamily] of [
    [320, 'day'],
    [320, 'day', 'DejaVu Sans'],
    [320, 'day', 'Liberation Sans'],
    [390, 'day'],
    [390, 'night'],
    [412, 'day']
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript((theme) => {
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false }));
      localStorage.setItem('jarvis.weather.locationAsked.v1', '1');
      const city = { name: '南京', latitude: 32.06, longitude: 118.8 };
      const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      const days = Array.from({ length: 7 }, (_, i) => ({
        date: new Date(Date.parse(date) + i * 86400000).toISOString().slice(0, 10),
        low: 14 + i,
        high: 22 + i,
        code: i === 2 ? 61 : 2,
        text: i === 2 ? '小雨' : '多云',
        rain: null,
        wind: '东北风 1–3级',
        uv: 3,
        sunrise: '06:18',
        sunset: '17:16'
      }));
      const data = {
        source: 'qweather',
        temp: 21,
        code: 2,
        text: '多云',
        isDay: true,
        at: date + 'T10:00',
        offset: 28800,
        days,
        fetchedAt: Date.now(),
        extra: {
          feels: 20,
          humidity: 63,
          wind: '东北风 2级（8 km/h）',
          pressure: 1016,
          vis: 20,
          precip: 0,
          air: { aqi: 38, category: '优' },
          hourly: Array.from({ length: 24 }, (_, i) => ({
            time: String((10 + i) % 24).padStart(2, '0') + ':00',
            temp: 20 + (i % 4),
            text: i > 12 ? '阴' : '多云',
            code: 2,
            pop: i > 12 ? 20 : 0
          })),
          rainSoon: '未来两小时无降水。',
          indices: [
            { name: '穿衣指数', category: '舒适', text: '早晚温差较大，建议穿长袖衬衫，出门带一件薄外套。' },
            { name: '运动指数', category: '适宜', text: '天气舒适，适合散步和慢跑；户外活动记得适量补水。' },
            { name: '紫外线指数', category: '中等', text: '午间外出建议涂抹防晒霜，长时间在户外可戴帽子。' }
          ],
          alerts: theme === 'night' ? [{ title: '示例城市大风蓝色预警', text: '请注意防范大风天气。'.repeat(30) + '这是预警原文的末句。' }] : []
        }
      };
      localStorage.setItem('jarvis.weather.city.v1', JSON.stringify(city));
      localStorage.setItem('jarvis.weather.cache.v1', JSON.stringify({ key: '32.06,118.80', data }));
    }, theme);
    let offline = false;
    await ctx.route('https://api.open-meteo.com/**', (route) => {
      if (offline) return route.abort();
      const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      return route.fulfill({
        json: {
          utc_offset_seconds: 28800,
          current: { temperature_2m: 18, weather_code: 61, is_day: 1, time: date + 'T10:00' },
          daily: { time: [date], temperature_2m_min: [14], temperature_2m_max: [21], weather_code: [61], precipitation_probability_max: [80] }
        }
      });
    });
    const page = await ctx.newPage(),
      errors = [];
    activePage = page;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(
      () =>
        window.__jarvis &&
        document.querySelector('#homepage-weather .home-weather-temp')?.textContent === '21°' &&
        document.querySelector('#app-splash')?.hidden !== false
    );
    if (fontFamily)
      await page.addStyleTag({
        content: `:root body.compact.companion-edition { --font-ui: '${fontFamily}', 'Noto Sans CJK SC', sans-serif; font-family: var(--font-ui); }`
      });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const label = `${width}-${theme}${fontFamily ? '-' + fontFamily.replace(/ /g, '-') : ''}`;
    check(label + '-home-no-overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(
      label + '-weather-right-aligned',
      await page.evaluate(() => {
        const detail = document.querySelector('.home-weather-details').getBoundingClientRect();
        const location = document.querySelector('.home-weather-location').getBoundingClientRect();
        return detail.left >= innerWidth / 2 - 12 && detail.right <= location.left && location.right <= innerWidth - 16;
      })
    );
    if (width === 320) {
      const layout = await page.evaluate(() => {
        const transcript = document.querySelector('#transcript');
        const rect = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height };
        };
        return {
          scroll: transcript.scrollHeight,
          client: transcript.clientHeight,
          home: rect('.home-reference'),
          weather: rect('.home-weather'),
          hero: rect('.home-hero'),
          suggestions: rect('.home-suggestions'),
          files: rect('.home-files'),
          input: rect('#inputbar'),
          viewport: innerHeight,
          font: getComputedStyle(document.body).fontFamily
        };
      });
      check(label + '-short-home-complete', layout.scroll <= layout.client + 2 && layout.files.bottom <= layout.input.top, layout);
    }
    check(label + '-range-visible', (await page.locator('.home-weather-condition').textContent()).includes('14° / 22°'));
    if (width === 390) await page.screenshot({ path: output + '/' + label + '-home.png' });
    await page.locator('.home-weather-location').click();
    check(label + '-location-separate', (await page.locator('.weather-city-view').isVisible()) && !(await page.locator('.weather-detail-view').isVisible()));
    await page.locator('.weather-close').click();
    await page.locator('.home-weather-details').click();
    check(label + '-seven-days', (await page.locator('.weather-day').count()) === 7);
    check(label + '-24-hours', (await page.locator('.weather-hour').count()) === 24);
    check(label + '-metrics-no-invalid', !/undefined|NaN/.test(await page.locator('.weather-extra').textContent()));
    check(label + '-dialog-no-overflow', await page.locator('.weather-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    check(label + '-source-qweather', (await page.locator('.weather-source').textContent()).includes('和风天气'));
    if (theme === 'night') {
      check(label + '-warning-advice-first', (await page.locator('.weather-detail-advice').textContent()).includes('先查看预警详情'));
      await page.locator('.weather-alert summary').click();
      check(label + '-warning-full-text', (await page.locator('.weather-alert p').textContent()).endsWith('这是预警原文的末句。'));
      await page.locator('.weather-alert summary').click();
    }
    if (width === 390) await page.screenshot({ path: output + '/' + label + '-detail.png' });
    await page.locator('.weather-life-section').scrollIntoViewIfNeeded();
    check(label + '-advice-readable-without-hover', await page.getByText('早晚温差较大，建议穿长袖衬衫，出门带一件薄外套。', { exact: true }).isVisible());
    if (width === 390) await page.screenshot({ path: output + '/' + label + '-life.png' });
    await page.locator('.weather-refresh').click();
    await page.waitForFunction(() => !document.querySelector('.weather-refresh').disabled);
    check(
      label + '-fallback-hides-life',
      !(await page.locator('.weather-life-section').isVisible()) && !(await page.locator('.weather-metrics-section').isVisible())
    );
    check(label + '-fallback-true-source', (await page.locator('.weather-source').textContent()).includes('Open-Meteo'));
    offline = true;
    await page.locator('.weather-refresh').click();
    await page.waitForFunction(() => !document.querySelector('.weather-refresh').disabled);
    check(label + '-cache-marked', (await page.locator('.weather-updated').textContent()).includes('缓存'));
    await page.locator('.weather-change').click();
    await page.locator('.weather-clear').click();
    check(label + '-clear-no-fake-temperature', (await page.locator('.home-weather-temp').textContent()) === '—');
    check(label + '-no-browser-errors', errors.length === 0);
    await ctx.close();
  }
} finally {
  if (checks.some((item) => !item.ok) && activePage && !activePage.isClosed()) await activePage.screenshot({ path: output + '/failure.png' });
  await fs.writeFile(output + '/summary.json', JSON.stringify(checks, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`天气卡片：${checks.filter((x) => x.ok).length}/${checks.length}`);
