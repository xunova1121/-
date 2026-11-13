/** 真实赛程组件：手机默认六场、展开收起、停用来源过滤，不改原sports-card验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sports-layout-'));
const out = process.argv[2] || directory;
await fs.mkdir(out, { recursive: true });
let browser, server;
try {
  await build({ stdin: { contents: `import {createSportsCard} from './src/ui/sportsCard.js'; window.mount=(value)=>document.body.replaceChildren(createSportsCard(value));`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, format: 'esm', outfile: path.join(directory, 'app.js') });
  server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://local').pathname;
    if (name === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{margin:12px;background:#f2f0ff;font-family:system-ui;color:#252337}.sports-card{background:white}</style><script type="module" src="/app.js"></script>'); return; }
    if (!['/app.js', '/app.css'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : 'text/css'); res.end(await fs.readFile(path.join(directory, name.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch(); let checks = 0;
  const snapshot = { version: 1, fetchedAt: Date.now(), query: { teams: ['蓝海队'] }, sources: [{ name: '直播吧', count: 12 }], lotteryNote: '虚构验收数据；来源未提供竞彩编号。',
    events: Array.from({ length: 12 }, (_, i) => ({ id: String(i), time: Date.now() + i * 60000, state: i < 3 ? 'in' : 'pre', home: `蓝海队${i + 1}`, away: `青山队${i + 1}`, score: i < 3 ? '1 : 0' : 'VS', status: i < 3 ? '中场' : '未开赛', source: '直播吧', league: '测试联赛' })) };
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.mount);
    await page.evaluate(value => window.mount(value), snapshot);
    assert.equal(await page.locator('.sports-card-match:visible').count(), 6); checks++;
    assert.equal(await page.locator('.sports-card-more summary').innerText(), '展开其余 6 场'); checks++;
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); checks++;
    await page.screenshot({ path: path.join(out, `sports-${width}.png`), fullPage: true });
    await page.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.sports-card-match:visible').count(), 12); checks++;
    await page.locator('summary').click(); assert.equal(await page.locator('.sports-card-match:visible').count(), 6); checks++;
    await page.evaluate(value => window.mount({ ...value, sources: [{ name: 'ESPN', count: 1 }], events: [{ ...value.events[0], source: 'ESPN', home: '已停用来源的队伍' }] }), snapshot);
    assert.equal(await page.locator('.sports-card-match').count(), 0); assert.ok(!(await page.locator('body').innerText()).includes('已停用来源的队伍')); checks++;
    assert.equal(errors.length, 0); checks++; await page.close();
  }
  console.log(`${checks}/${checks} sports layout passed`);
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
