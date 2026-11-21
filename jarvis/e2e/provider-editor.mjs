/**
 * 手机版“服务商”页：点最后一张卡片的“配置 ›”，编辑框要紧跟标题打开并滚到看得见的地方
 * （以前加在卡片最底下，自定义（OpenAI 兼容）在页面最下面，点了像没反应）
 * 用法：npm run build:mobile && node e2e/provider-editor.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http'; import path from 'node:path'; import { readFile } from 'node:fs/promises'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-mobile');
const server = http.createServer(async (req, res) => { const p = new URL(req.url, 'http://x').pathname; try { const f = path.resolve(ROOT, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1))); res.writeHead(200, { 'Content-Type': { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp' }[path.extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); } catch { res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const CONFIG = { provider: 'relay-multi', models: { 'relay-multi': 'gpt-5.6-luna' }, keys: { 'relay-multi': 'sk', custom: 'k2' }, baseURLs: { 'relay-multi': 'https://api.teamorouter.cn/v1' }, providerNames: { custom: '自定义（OpenAI 兼容）' }, favoriteModels: [] };
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ctx.addInitScript((c) => { if (window.top !== window) return; localStorage.setItem('jarvis.llm.v1', c); localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })); }, JSON.stringify(CONFIG));
const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__jarvis); await page.waitForTimeout(1200);
await page.evaluate(() => window.__jarvis.showPanel('models')); await page.waitForTimeout(800);
await page.getByRole('button', { name: '服务商' }).first().click(); await page.waitForTimeout(500);
const cards = await page.locator('.ml-provider').evaluateAll((els) => els.map((e) => e.querySelector('strong')?.textContent));
const card = page.locator('.ml-provider').filter({ hasText: '自定义' });
await card.getByRole('button', { name: '配置 ›' }).tap();
await page.waitForTimeout(500);
const box = await card.locator('.ml-editor').boundingBox();
const vh = page.viewportSize().height;
const ok = cards.at(-1)?.includes('自定义') && box && box.y < vh && box.y + 60 > 0 && errs.length === 0;
console.log(`${ok ? '✓' : '✗'} 最后一张卡片点“配置”，编辑框在屏幕上看得见 — ${box ? Math.round(box.y) : 'none'}/${vh} ${errs.join('；')}`);
await browser.close(); server.close();
process.exit(ok ? 0 : 1);
