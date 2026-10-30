/** 构建后的PC/手机版，真实任务预查→SSE卡片→历史回放→认证刷新；不访问真实模型或比分接口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
const out = path.resolve(process.argv[2] || '/tmp/weiyang-sports-card');
await fs.mkdir(out, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-sports-card-'));
const portSocket = http.createServer(); await new Promise(r => portSocket.listen(0, '127.0.0.1', r)); const port = portSocket.address().port; await new Promise(r => portSocket.close(r));
const base = `http://127.0.0.1:${port}`, password = 'sports-fixture-password';
const child = spawn(process.execPath, ['e2e/fixtures/sports-server.mjs'], { env: { ...process.env, PORT: String(port), JARVIS_DATA: data, JARVIS_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, mobileWeb, page;
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const checks = [];
const check = (label, ok) => { checks.push({ label, ok }); assert.equal(ok, true, label); };
try {
  for (let i = 0; i < 100 && (!logs.includes('sports-fixture-ready') || !logs.includes('sports-local-ready:')); i++) { if (child.exitCode !== null) throw Error(logs); await new Promise(r => setTimeout(r, 100)); }
  assert.ok(logs.includes('sports-fixture-ready') && logs.includes('sports-local-ready:'), logs);
  check('unauthorized-refresh-rejected', (await fetch(base + '/api/sports/scores?period=around')).status === 401);
  const cors = await fetch(base + '/api/sports/scores?period=around', { method: 'OPTIONS', headers: { Origin: 'https://localhost', 'Access-Control-Request-Headers': 'authorization' } });
  check('android-cors-before-auth', cors.status === 204 && cors.headers.get('access-control-allow-headers').includes('authorization'));
  const token = (await (await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })).json()).token;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const root = path.resolve('dist-mobile');
  mobileWeb = http.createServer(async (req, res) => {
    try { const file = path.resolve(root, new URL(req.url, 'http://x').pathname.slice(1) || 'index.html'); if (!file.startsWith(root + path.sep)) throw Error('outside'); res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => mobileWeb.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const width of [390, 320, 412, 1280]) {
    const mobile = width < 500;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(({ base, token }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ enabled: true, url: base, token }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
    }, { base, token });
    page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(mobile ? `http://127.0.0.1:${mobileWeb.address().port}` : base);
    await page.waitForFunction(() => window.__jarvis);
    // 使用实际输入入口发任务，不能只向DOM塞一张孤立卡片。
    await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
    await page.fill('#prompt', '足彩赛程'); await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelector('.sports-card') && !document.querySelector('.msg.agent.streaming'), null, { timeout: 30000 });
    const card = page.locator('.sports-card').last();
    check(`${width}-live-first-and-no-finished`, await card.locator('.sports-card-match').count() === 2 && (await card.locator('.sports-card-match').first().textContent()).includes('中场'));
    check(`${width}-no-invented-league-lottery`, (await card.textContent()).includes('联赛名未提供') && (await card.textContent()).includes('未提供可核实的竞彩场次编号'));
    const bounds = await card.evaluate(el => ({ width: el.getBoundingClientRect().width, client: el.clientWidth, scroll: el.scrollWidth, viewport: innerWidth, right: el.getBoundingClientRect().right }));
    check(`${width}-no-card-horizontal-overflow`, bounds.scroll <= bounds.client && bounds.right <= bounds.viewport && bounds.width > 150);
    if (!mobile) check('desktop-card-compact-width', bounds.width <= 640);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `sports-${width}.png`), fullPage: false });
    const before = JSON.parse(await fs.readFile(path.join(data, 'fixture-stats.json')));
    const scoreBefore = await card.locator('.sports-match-score').first().textContent();
    await card.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(old => document.querySelector('.sports-card .sports-match-score')?.textContent !== old && !document.querySelector('.sports-card-refresh')?.disabled, scoreBefore);
    const after = JSON.parse(await fs.readFile(path.join(data, 'fixture-stats.json')));
    check(`${width}-refresh-fetches-without-model`, after.upstreamCalls > before.upstreamCalls && after.modelCalls === before.modelCalls);
    if (width === 390) {
      await page.reload(); await page.waitForFunction(() => document.querySelector('.sports-card'));
      check('server-history-replays-card', (await page.locator('.sports-card').last().textContent()).includes('江城星光'));
      await fs.writeFile(path.join(data, 'fail-all'), '1');
      const old = await page.locator('.sports-card').last().locator('.sports-match-score').first().textContent();
      await page.locator('.sports-card').last().getByRole('button', { name: '刷新', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.sports-card-error')?.textContent.includes('刷新失败'));
      check('refresh-failure-retains-known-result', await page.locator('.sports-match-score').first().textContent() === old);
      await fs.unlink(path.join(data, 'fail-all'));
    }
    check(`${width}-no-browser-errors`, errors.length === 0);
    await context.close(); page = null;
  }
  // 电脑版本机模式也走原toolbox回调；验证没有只修好服务器模式。
  const local = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await local.addInitScript(() => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })));
  page = await local.newPage();
  await page.goto('http://127.0.0.1:' + logs.match(/sports-local-ready:(\d+)/)[1]); await page.waitForFunction(() => window.__jarvis);
  const localBefore = JSON.parse(await fs.readFile(path.join(data, 'fixture-stats.json')));
  await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
  await page.fill('#prompt', '足彩赛程'); await page.click('#btn-send');
  await page.waitForFunction(() => document.querySelector('.sports-card') && !document.querySelector('.msg.agent.streaming'), null, { timeout: 30000 });
  check('pc-local-toolbox-card', (await page.locator('.sports-card').textContent()).includes('江城星光'));
  const localAfter = JSON.parse(await fs.readFile(path.join(data, 'fixture-stats.json')));
  check('pc-local-task-does-not-use-server-model', localAfter.modelCalls === localBefore.modelCalls);
  await page.reload(); await page.waitForFunction(() => document.querySelector('.sports-card'));
  check('pc-local-history-replays-card', true);
  await local.close(); page = null;
  const sessions = await (await fetch(base + '/api/sessions', { headers })).json();
  const saved = await (await fetch(base + '/api/sessions/' + sessions[0].id, { headers })).json();
  check('session-api-contains-bounded-card', JSON.stringify(saved).includes('sports') && JSON.stringify(saved).includes('江城星光') && saved.messages.at(-1).sports.events.length <= 12);
  console.log(`赛程卡：${checks.length}/${checks.length}`);
} catch (e) {
  checks.push({ label: 'unexpected-error', ok: false, error: String(e.stack || e) });
  throw e;
} finally {
  if (checks.some(c => !c.ok) && page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') });
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(checks, null, 2));
  await fs.writeFile(path.join(out, 'server.log'), logs);
  await browser?.close(); if (mobileWeb) await new Promise(r => mobileWeb.close(r));
  child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit');
  await fs.rm(data, { recursive: true, force: true });
}
