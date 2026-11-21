/** 真实聊天入口：本地 HTTP 行情→工具 typed event→手机/PC 卡片→重开历史；不访问外网模型或行情。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-market-card');
await fs.mkdir(out, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-market-card-'));
const portSocket = http.createServer();
await new Promise(resolve => portSocket.listen(0, '127.0.0.1', resolve));
const port = portSocket.address().port;
await new Promise(resolve => portSocket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = 'market-fixture-password';
const child = spawn(process.execPath, ['e2e/fixtures/market-server.mjs'], { env: { ...process.env, PORT: String(port), JARVIS_DATA: data, JARVIS_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, mobileWeb, page;
child.stdout.on('data', buffer => { logs += buffer; });
child.stderr.on('data', buffer => { logs += buffer; });
const checks = [];
const check = (label, ok) => { checks.push({ label, ok }); assert.equal(ok, true, label); };
async function send(text, count) {
  await page.fill('#prompt', text);
  await page.click('#btn-send');
  await page.waitForFunction(expected => document.querySelectorAll('.market-card').length === expected && !document.querySelector('.msg.agent.streaming'), count, { timeout: 30000 });
}
try {
  for (let i = 0; i < 100 && !logs.includes('market-fixture-ready'); i++) {
    if (child.exitCode !== null) throw Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(logs.includes('market-fixture-ready'), logs);
  const login = await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const token = (await login.json()).token;
  assert.ok(token);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const root = path.resolve('dist-mobile');
  mobileWeb = http.createServer(async (req, res) => {
    try {
      const file = path.resolve(root, new URL(req.url, 'http://fixture').pathname.slice(1) || 'index.html');
      if (!file.startsWith(root + path.sep)) throw Error('outside');
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => mobileWeb.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const width of [390, 1280]) {
    const mobile = width < 500;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(({ base, token }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ enabled: true, url: base, token }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
    }, { base, token });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(mobile ? `http://127.0.0.1:${mobileWeb.address().port}` : base);
    await page.waitForFunction(() => window.__jarvis);
    // 服务器会自动恢复最近对话；每个视口先通过真实动作建自己的新会话。
    await page.evaluate(() => window.__jarvis.newSession());
    await page.waitForFunction(() => document.querySelectorAll('.market-card').length === 0);
    await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
    await send('600519实时行情', 1);
    const quote = page.locator('.market-card').first();
    const text = await quote.textContent();
    check(`${width}-actual-quote-values-unit-time-source`, ['验收示例股份', '1500', '元', '2026-11-11', '15:00', '腾讯行情'].every(value => text.replaceAll(',', '').includes(value)));
    check(`${width}-quote-source-is-provider-url`, (await quote.locator('a').evaluateAll(elements => elements.map(element => element.href))).some(url => url.startsWith('https://qt.gtimg.cn/')));
    check(`${width}-quote-does-not-invent-chart`, await quote.locator('.market-chart, svg polyline').count() === 0);
    const bounds = await quote.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth, right: element.getBoundingClientRect().right, viewport: innerWidth }));
    check(`${width}-no-horizontal-overflow`, bounds.scroll <= bounds.client && bounds.right <= bounds.viewport && bounds.width > 150);
    await quote.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `market-quote-${width}.png`), fullPage: false });

    await send('600519 收盘价', 2);
    const kline = page.locator('.market-card').last();
    const chart = kline.locator('.market-chart');
    check(`${width}-real-kline-chart-present`, await chart.count() === 1);
    const klineText = (await kline.textContent()).replaceAll(',', '');
    check(`${width}-kline-date-and-source`, ['2026-11-09', '2026-11-11', '腾讯行情', '1512'].every(value => klineText.includes(value)));
    const linePoints = await chart.locator('polyline').getAttribute('points');
    check(`${width}-exactly-three-real-close-points`, linePoints.trim().split(/\s+/).length === 3 && await chart.locator('polyline').getAttribute('data-count') === '3');
    const points = linePoints.trim().split(/\s+/).map(point => point.split(',').map(Number));
    check(`${width}-line-follows-real-decrease-then-increase`, points[1][1] > points[0][1] && points[2][1] < points[0][1]);
    await chart.locator('circle').nth(1).focus();
    check(`${width}-chart-point-shows-real-date-and-close`, (await kline.locator('.market-chart-readout').textContent()).replaceAll(',', '').includes('2026-11-10 收盘 1496'));
    await kline.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `market-kline-${width}.png`), fullPage: false });
    const before = JSON.parse(await fs.readFile(path.join(data, 'fixture-stats.json')));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.market-card').length === 2);
    const after = JSON.parse(await fs.readFile(path.join(data, 'fixture-stats.json')));
    check(`${width}-history-replays-both-real-cards`, (await page.locator('.market-card').first().textContent()).includes('验收示例股份') && await page.locator('.market-card .market-chart polyline').count() === 1);
    check(`${width}-history-no-extra-model-or-upstream`, JSON.stringify(before) === JSON.stringify(after));
    check(`${width}-no-browser-errors`, errors.length === 0);
    await context.close();
    page = null;
  }
  const all = await (await fetch(base + '/api/sessions', { headers })).json();
  const saved = (await Promise.all(all.map(async session => (await fetch(base + '/api/sessions/' + session.id, { headers })).json()))).filter(session => session.messages.length);
  check('session-api-persists-real-bounded-snapshots', saved.every(session => {
    const cards = session.messages.flatMap(message => message.markets || []);
    return cards.length === 2 && cards[0].quotes[0].price === 1500 && cards[1].bars.map(bar => bar.close).join(',') === '1500,1496,1512' && Buffer.byteLength(JSON.stringify(cards)) <= 16384;
  }));
  console.log(`行情卡：${checks.length}/${checks.length}`);
} catch (error) {
  checks.push({ label: 'unexpected-error', ok: false, error: String(error.stack || error) });
  throw error;
} finally {
  if (checks.some(item => !item.ok) && page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') });
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(checks, null, 2));
  await fs.writeFile(path.join(out, 'server.log'), logs);
  await browser?.close();
  if (mobileWeb) await new Promise(resolve => mobileWeb.close(resolve));
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
  await fs.rm(data, { recursive: true, force: true });
}
