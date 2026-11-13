/** 国内网络故障场景：真实任务/工具/模型中心，只替换固定上游和模型为虚构内容。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
const out = path.resolve(process.argv[2] || '/tmp/weiyang-lookup-step1');
await fs.mkdir(out, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'lookup-step1-e2e-'));
const socket = http.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = 'http://127.0.0.1:' + port, password = 'lookup-fixture-password';
const child = spawn(process.execPath, ['e2e/fixtures/news-server.mjs'], { env: { ...process.env, PORT: String(port), JARVIS_DATA: data, JARVIS_PASSWORD: password, LOOKUP_CN_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, mobileWeb, page;
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const checks = [], check = (label, ok) => { checks.push({ label, ok }); assert.equal(ok, true, label); };
try {
  for (let i = 0; i < 150 && !logs.includes('news-fixture-ready'); i++) {
    if (child.exitCode !== null) throw Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(logs.includes('news-fixture-ready'), logs);
  const token = (await (await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })).json()).token;
  const api = (p, init = {}) => fetch(base + p, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  check('health-auth-required', (await fetch(base + '/api/server/lookup-health')).status === 401);
  check('probe-auth-required', (await fetch(base + '/api/server/lookup-health', { method: 'POST' })).status === 401);
  const beforeStatus = JSON.parse(await fs.readFile(path.join(data, 'news-stats.json')));
  const snapshot = await (await api('/api/server/lookup-health')).json();
  check('status-no-model-or-network', JSON.stringify(beforeStatus) === await fs.readFile(path.join(data, 'news-stats.json'), 'utf8'));
  check('domestic-source-approvals', snapshot.sources.find(s => s.id === 'cn_cns_sports').validation === 'cn_verified' && snapshot.sources.find(s => s.id === 'cn_sina_sports').validation === 'not_selected');
  check('invalid-region-rejected', (await api('/api/server/config', { method: 'PUT', body: JSON.stringify({ lookupRegion: 'elsewhere' }) })).status === 400);
  const root = path.resolve('dist-mobile');
  mobileWeb = http.createServer(async (req, res) => {
    try {
      const file = path.resolve(root, new URL(req.url, 'http://x').pathname.slice(1) || 'index.html');
      if (!file.startsWith(root + path.sep)) throw Error('outside');
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => mobileWeb.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500, hasTouch: width < 500 });
    await context.addInitScript(({ base, token }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ enabled: true, url: base, token }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock', keys: {}, models: {}, lookupRegion: 'auto' }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
    }, { base, token });
    page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(width < 500 ? 'http://127.0.0.1:' + mobileWeb.address().port : base);
    await page.waitForFunction(() => window.__jarvis);
    await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
    for (const [question, category] of [['体育资讯', '体育'], ['国际新闻', '国际']]) {
      const before = JSON.parse(await fs.readFile(path.join(data, 'news-stats.json')));
      await page.fill('#prompt', question); await page.click('#btn-send');
      await page.waitForFunction(category => [...document.querySelectorAll('.msg.agent')].at(-1)?.textContent.includes('虚构' + category + '报道') && !document.querySelector('.msg.agent.streaming'), category, { timeout: 30000 });
      const after = JSON.parse(await fs.readFile(path.join(data, 'news-stats.json')));
      const answer = page.locator('.msg.agent').last();
      check(width + '-' + category + '-domestic-content-with-foreign-blocked', (await answer.textContent()).includes('中新网'));
      const articleUrls = await answer.locator('.body a').evaluateAll(links => [...new Set(links.map(link => link.href).filter(url => /^https:\/\/(?:www\.chinanews\.com\.cn\/ty\/\d{4}|news\.zhibo8\.com\/zuqiu\/\d{4})\//.test(url)))]);
      check(width + '-' + category + '-at-least-five', articleUrls.length >= 5);
      check(width + '-' + category + '-one-model-eight-read-cap', after.models - before.models === 1 && after.upstream - before.upstream <= 8);
      check(width + '-' + category + '-no-score-card', await answer.locator('.sports-card').count() === 0);
    }
    await page.screenshot({ path: path.join(out, 'domestic-news-' + width + '.png') });
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    await page.waitForSelector('.ml-lookup', { state: 'attached' });
    if (width < 500) await page.getByRole('navigation', { name: '模型中心分类' }).getByRole('button', { name: '服务商', exact: true }).click();
    await page.locator('.ml-lookup summary').click();
    await page.getByRole('button', { name: '查看来源状态', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ml-lookup [role=status]')?.textContent.includes('云服务器当前按国内'));
    check(width + '-health-reflects-real-tool-run', (await page.getByLabel('查询来源健康状态').textContent()).includes('可读取'));
    await page.getByLabel('信息查询地区').selectOption('global');
    await page.getByRole('button', { name: '保存查询地区', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ml-lookup [role=status]')?.textContent.includes('已保存到云服务器'));
    check(width + '-server-region-saved', (await (await api('/api/server/config')).json()).lookupRegion === 'global');
    check(width + '-local-region-not-overwritten', await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).lookupRegion === 'auto'));
    await page.getByLabel('信息查询地区').selectOption('cn'); await page.getByRole('button', { name: '保存查询地区', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.ml-lookup button')?.disabled && document.querySelector('.ml-lookup [role=status]')?.textContent.includes('已保存到云服务器'));
    const beforeProbe = JSON.parse(await fs.readFile(path.join(data, 'news-stats.json')));
    await page.getByRole('button', { name: '检查来源连通', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ml-lookup [role=status]')?.textContent.includes('云服务器当前按国内'));
    const afterProbe = JSON.parse(await fs.readFile(path.join(data, 'news-stats.json')));
    check(width + '-probe-network-without-model', afterProbe.upstream > beforeProbe.upstream && afterProbe.models === beforeProbe.models);
    check(width + '-no-horizontal-overflow', await page.locator('.ml-lookup').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    check(width + '-no-browser-errors', errors.length === 0);
    await page.screenshot({ path: path.join(out, 'lookup-settings-' + width + '.png') });
    await context.close(); page = null;
  }
  console.log(`查询第1步：${checks.length}/${checks.length}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); if (mobileWeb) await new Promise(r => mobileWeb.close(r));
  child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit');
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ checks }, null, 2));
  await fs.writeFile(path.join(out, 'server.log'), logs);
  await fs.rm(data, { recursive: true, force: true });
}
