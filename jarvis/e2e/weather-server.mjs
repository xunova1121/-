/** 安卓实际构建 → 跨域认证 → 实际服务器配置/天气代理；只替换虚构上游，不预埋和风缓存。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-weather-server');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-weather-server-'));
await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ qweatherKey: 'server-weather-fixture', qweatherHost: 'fixture.re.qweatherapi.com' }));
const socket = http.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const preload = `import {installWeatherFixture} from ${JSON.stringify(pathToFileURL(path.resolve('e2e/fixtures/weather-upstream.mjs')).href)};installWeatherFixture();`;
const gateway = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), 'server/server.mjs'], { env: { ...process.env, PORT: String(port), JARVIS_DATA: data, JARVIS_PASSWORD: 'weather-test-password', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
gateway.stdout.on('data', b => logs += b);
gateway.stderr.on('data', b => logs += b);
let browser, web, page;
const checks = [];
const check = (label, ok) => { checks.push({ label, ok }); assert.equal(ok, true, label); };
try {
  for (let i = 0; i < 100 && !logs.includes('服务器模式已开启'); i++) {
    if (gateway.exitCode !== null) throw Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(logs.includes('服务器模式已开启'), logs);
  const token = (await (await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'weather-test-password' }) })).json()).token;
  const api = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  for (const endpoint of ['/api/weather?latitude=32.06&longitude=118.8', '/api/weather/cities?q=118.80,32.06']) {
    check(endpoint + '-requires-login', (await fetch(base + endpoint)).status === 401);
    const preflight = await fetch(base + endpoint, { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Headers': 'authorization' } });
    check(endpoint + '-android-cors', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*' && preflight.headers.get('access-control-allow-headers').includes('authorization'));
  }
  const root = path.resolve('dist-mobile');
  web = http.createServer(async (req, res) => {
    try {
      const p = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(root, p === '/' ? 'index.html' : p.slice(1));
      if (!file.startsWith(root + path.sep)) throw Error('outside');
      res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ base, token }) => {
    localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
    localStorage.setItem('jarvis.weather.locationAsked.v1', '1');
    if (!localStorage.getItem('jarvis.weather.city.v1')) {
      localStorage.setItem('jarvis.weather.city.v1', JSON.stringify({ name: '附近', latitude: 32.06, longitude: 118.8, source: 'location' }));
      const date = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      localStorage.setItem('jarvis.weather.cache.v1', JSON.stringify({ key: '32.06,118.80', data: { temp: 9, code: 0, isDay: true, at: date + 'T12:00', offset: 28800, days: [{ date, low: 8, high: 15, rain: 0, code: 0 }], fetchedAt: Date.now() } }));
    }
  }, { base, token });
  let directCalls = 0;
  await context.route(/https:\/\/(?:api\.open-meteo\.com|[^/]*qweatherapi\.com)\//, route => { directCalls++; return route.abort(); });
  page = await context.newPage();
  const errors = [], weatherCalls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { if (req.url().startsWith(base + '/api/weather')) weatherCalls.push(req); });
  await page.goto(`http://127.0.0.1:${web.address().port}`);
  await page.waitForFunction(() => document.querySelector('.home-weather-temp')?.textContent === '21°' && document.querySelector('.home-city b')?.textContent === '鼓楼区');
  check('cloud-request-authenticated', weatherCalls.length >= 2 && weatherCalls.every(r => r.headers().authorization === 'Bearer ' + token));
  check('no-direct-local-weather', directCalls === 0);
  check('old-nearby-cache-replaced', !(await page.locator('#homepage-weather').textContent()).includes('附近'));
  check('server-key-stays-server', !(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes('server-weather-fixture'));
  await page.screenshot({ path: path.join(output, 'home-district.png') });
  await page.locator('.home-weather-details').click();
  check('city-and-district-visible', (await page.locator('.weather-current').textContent()).includes('南京市 · 鼓楼区'));
  check('actual-proxy-seven-days', await page.locator('.weather-day').count() === 7);
  check('actual-proxy-24-hours', await page.locator('.weather-hour').count() === 24);
  check('source-qweather', (await page.locator('.weather-source').textContent()).includes('和风天气'));
  await page.screenshot({ path: path.join(output, 'cloud-detail.png') });
  await page.locator('.weather-life-section').scrollIntoViewIfNeeded();
  check('actual-life-advice', await page.getByText('早晚温差较大，建议带一件薄外套。', { exact: true }).isVisible());
  // 云配置删除后强制刷新；不能借用旧天气缓存继续声称和风。
  await api('/api/server/config', { method: 'PUT', body: JSON.stringify({ qweatherHost: '' }) });
  await page.evaluate(() => dispatchEvent(new Event('jarvis:weather-config-changed')));
  await page.waitForFunction(() => document.querySelector('.home-weather-temp')?.textContent === '18°');
  check('cloud-missing-key-explained', (await page.locator('.weather-provider-note').textContent()).includes('云服务器未配置'));
  check('fallback-true-source', (await page.locator('.weather-source').textContent()).includes('Open-Meteo'));
  await page.locator('.weather-configure').click();
  await page.waitForFunction(() => document.querySelector('#model-workspace')?.textContent.includes('服务商与 Key'));
  check('configure-opens-model-center', !(await page.locator('#homepage-weather-dialog').evaluate(el => el.open)));
  check('configure-targets-cloud', await page.getByRole('button', { name: '云服务器', exact: true }).getAttribute('aria-pressed') === 'true');
  await page.locator('.mc-nav').getByRole('button', { name: '服务商', exact: true }).click();
  await page.locator('.ml-service-keys summary').click();
  await page.getByLabel('和风天气 API Host', { exact: true }).fill('fixture.re.qweatherapi.com');
  await page.getByLabel('和风天气 Key', { exact: true }).fill('server-weather-fixture');
  await page.getByRole('button', { name: '保存到云服务器', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.home-weather-temp')?.textContent === '21°');
  check('saving-cloud-key-refreshes-weather', true);
  check('saving-cloud-key-never-copies-local', !(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes('server-weather-fixture'));
  await context.route(base + '/api/weather?**', route => route.fulfill({ status: 401, json: { error: '请先登录' }, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.evaluate(() => dispatchEvent(new Event('jarvis:weather-config-changed')));
  await page.waitForFunction(() => document.querySelector('.weather-updated')?.textContent.includes('服务器登录已失效'));
  check('expired-login-no-silent-fallback', directCalls === 0 && (await page.locator('.weather-source').textContent()).includes('和风天气') && (await page.locator('.weather-updated').textContent()).includes('缓存'));
  check('no-browser-errors', errors.length === 0);
  console.log(`服务器天气链路：${checks.length}/${checks.length}`);
} finally {
  if (checks.some(c => !c.ok) && page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') });
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(checks, null, 2));
  await browser?.close();
  if (web) await new Promise(r => web.close(r));
  gateway.kill('SIGTERM');
  if (gateway.exitCode === null) await once(gateway, 'exit');
  await fs.rm(data, { recursive: true, force: true });
}
