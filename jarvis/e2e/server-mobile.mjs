/**
 * 手机版连服务器的端到端测试：先 npm run build:mobile，再执行
 *   node e2e/server-mobile.mjs [截图输出目录]
 * 自己启动一个开了服务器模式的网关（临时数据目录、内置演示模型），用手机尺寸打开手机版：
 * 对话列表、搜索、重命名 / 置顶 / 删除、另一台设备接着聊后切回来能看到、断网时先显示手机上留的副本、网络耗时
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '.';
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'e2e-password-456';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-mobile-server-'));
const gw = spawn(process.execPath, ['server/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), JARVIS_DATA: dataDir, JARVIS_PASSWORD: PASS, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
gw.stdout.on('data', (d) => { log += d; });
gw.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 50 && !/服务器模式已开启/.test(log); i++) await new Promise((r) => setTimeout(r, 200));

const token = (await (await fetch(`${BASE}/api/server/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) })).json()).token;
const api = (p, init = {}) => fetch(BASE + p, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
const now = Date.now();
for (let i = 0; i < 12; i++) {
  await api('/api/sessions/import', { method: 'POST', body: JSON.stringify({ id: `m${i}`, title: `测试对话 ${i}`, titleSet: true, createdAt: now - i * 3600_000, updatedAt: now - i * 3600_000, messages: [{ role: 'user', content: `第 ${i} 段的问题`, ts: 1 }, { role: 'assistant', content: `第 ${i} 段的回答`, ts: 2 }] }) });
}

// 手机版的网页（App 里是本机地址，跨域连服务器）
const DIST = path.join(ROOT, 'dist-mobile');
const web = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    const f = path.resolve(DIST, p === '/' ? 'index.html' : p.slice(1));
    if (!f.startsWith(DIST)) throw new Error('outside');
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.wasm': 'application/wasm' }[path.extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${web.address().port}`;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([url, t]) => {
    if (window.top !== window) return;
    if (!localStorage.getItem('jarvis.server.v1')) localStorage.setItem('jarvis.server.v1', JSON.stringify({ url, token: t, enabled: true }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day' }));
    window.prompt = () => window.__nextPrompt ?? null;
    window.confirm = () => true;
  }, [BASE, token]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP);
  await page.waitForFunction(() => window.__jarvis);

  // 列表、搜索
  await page.click('#btn-menu');
  await page.waitForFunction(() => document.querySelectorAll('.drawer-item').length >= 8, null, { timeout: 15000 });
  check('打开菜单列出服务器上的对话（最近 8 条，其余收在“展开更多”）', await page.locator('.drawer-item').count() === 8 && /还有 4 条/.test(await page.locator('.drawer-more').textContent()));
  await page.fill('.drawer-search', '对话 11');
  const hits = await page.locator('.drawer-item').allTextContents();
  check('按标题搜索对话', hits.length === 1 && /测试对话 11/.test(hits[0]), hits.join(' / '));
  await page.fill('.drawer-search', '');
  await page.dispatchEvent('.drawer-search', 'input');

  // 重命名、置顶、删除
  const rowOf = (title) => page.locator('.drawer-row', { hasText: title }).first();
  await page.evaluate(() => { window.__nextPrompt = '改过名的对话'; });
  await rowOf('测试对话 2').locator('.drawer-item-more').click();
  await page.locator('.drawer-menu button', { hasText: '重命名' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.drawer-item')].some((b) => b.textContent.includes('改过名的对话')), null, { timeout: 8000 }).catch(() => {});
  const renamed = await (await api('/api/sessions/m2')).json();
  check('列表里能重命名，服务器上也改了', renamed.title === '改过名的对话');
  await rowOf('测试对话 5').locator('.drawer-item-more').click();
  await page.locator('.drawer-menu button', { hasText: '置顶' }).click();
  await page.waitForFunction(() => document.querySelector('.drawer-group')?.textContent.includes('置顶'), null, { timeout: 8000 }).catch(() => {});
  check('列表里能置顶，置顶的排在最前', (await (await api('/api/sessions/m5')).json()).pinned === true && /置顶/.test(await page.locator('.drawer-group').first().textContent()));
  await rowOf('测试对话 7').locator('.drawer-item-more').click();
  await page.locator('.drawer-menu button', { hasText: '删除' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.drawer-item')].some((b) => b.textContent.includes('测试对话 7')), null, { timeout: 8000 }).catch(() => {});
  check('列表里能删除（先确认），服务器上也删了', (await api('/api/sessions/m7')).status === 404);

  // 打开一段对话；另一台设备接着聊了以后，切回来（App 回到前台）能看到最新进度
  await rowOf('测试对话 3').locator('.drawer-item').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('第 3 段的问题')), null, { timeout: 10000 });
  check('点一下就打开对话', true);
  const task = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify({ sessionId: 'm3', text: '电脑上接着问的一句' }) })).json();
  for (let i = 0; i < 100; i++) { const t = await (await api(`/api/tasks/${task.id}`)).json(); if (t.status === 'done') break; await new Promise((r) => setTimeout(r, 200)); }
  await page.waitForTimeout(3200); // 两次刷新之间至少隔 3 秒
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('电脑上接着问的一句')), null, { timeout: 10000 }).catch(() => {});
  check('另一台设备接着聊过：切回来时自动拉到最新进度', await page.evaluate(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('电脑上接着问的一句'))));

  // 网络耗时
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  check('设置里显示最近请求花了多久', /最近请求：.*对话列表/.test(await page.locator('#server-net').textContent()), await page.locator('#server-net').textContent());

  // 服务器连不上时重新打开：先显示手机上留的副本
  await page.route(`${BASE}/**`, (r) => r.abort());
  await page.reload();
  await page.waitForFunction(() => window.__jarvis);
  await page.click('#btn-menu');
  await page.waitForFunction(() => document.querySelectorAll('.drawer-item').length > 0, null, { timeout: 5000 }).catch(() => {});
  check('连不上服务器时，菜单里先显示手机上留的对话列表', await page.locator('.drawer-item').count() >= 8);
  await rowOf('测试对话 3').locator('.drawer-item').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('第 3 段的问题')), null, { timeout: 5000 }).catch(() => {});
  check('连不上服务器时，打开过的对话先显示手机上留的内容', await page.evaluate(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('第 3 段的问题'))));
  await page.screenshot({ path: path.join(OUT, 'server-mobile.png') });
  check('没有页面错误', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  web.close();
  gw.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n手机版连服务器 ${results.filter(Boolean).length}/${results.length} 通过`);
if (results.some((x) => !x)) process.exitCode = 1;
