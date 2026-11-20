/** npm run build:mobile && node e2e/work-studio-mobile.mjs [截图目录] */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../dist-mobile', import.meta.url));
const base = 'https://weiyang.test';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.wasm': 'application/wasm' };
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) return route.abort();
    try {
      const body = await readFile(file);
      await route.fulfill({ body, contentType: types[path.extname(file)] || 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false, theme: 'day' }));
  });
  page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__jarvis && document.body.classList.contains('compact') && document.querySelector('#app-splash')?.hidden !== false);
  const entry = page.getByRole('button', { name: '看未央工作', exact: true });
  const sheet = page.getByRole('dialog', { name: '未央工作室', exact: true });
  assert.equal(await entry.count(), 0);
  assert.equal(await sheet.count(), 0);

  async function send(text) {
    await page.fill('#prompt', text);
    await page.click('#btn-send');
  }

  await send('列出工作区文件');
  await entry.click();
  await sheet.waitFor();
  await sheet.locator('.ws-row').filter({ hasText: '列出文件' }).waitFor();
  await sheet.locator('.ws-row').filter({ hasText: '已完成本轮回复' }).waitFor();
  const bounds = await sheet.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845);
  assert(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await sheet.locator('.ws-row').filter({ hasText: '列出文件' }).click();
  assert.equal(await sheet.locator('.ws-action').textContent(), '列出文件');
  if (process.argv[2]) {
    await mkdir(process.argv[2], { recursive: true });
    await page.screenshot({ path: path.join(process.argv[2], 'mobile-studio.png') });
  }
  await sheet.getByRole('button', { name: '返回对话' }).click();
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('mobile-studio-entry'));
  const card = page.locator('.msg.agent').last().locator('.progress-card');
  await card.locator(':scope > summary').click();
  assert.equal(await card.evaluate(el => el.open), true);
  await entry.click();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await card.evaluate(el => el.open), true);
  await send('你好');
  await page.waitForFunction(() => {
    const bubbles = document.querySelectorAll('#transcript > .msg.agent');
    return bubbles.length === 2 && bubbles[1].contains(document.querySelector('.mobile-studio-entry'));
  });
  assert.equal(await entry.count(), 1);
  await entry.click();
  await sheet.locator('.ws-row').filter({ hasText: '已完成本轮回复' }).waitFor();
  assert.equal(await sheet.locator('.ws-row').filter({ hasText: '列出文件' }).count(), 0);
  await page.setViewportSize({ width: 844, height: 390 });
  assert(await sheet.evaluate(el => el.getBoundingClientRect().height <= innerHeight && el.scrollWidth <= el.clientWidth + 1));
  // 转到另一会话时，旧入口和打开的工作室同时退出。
  await page.evaluate(() => window.__jarvis.newSession());
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await entry.count(), 0);
  assert.deepEqual(errors, []);
  console.log('手机工作室通过：真实工具记录、横竖屏、返回与焦点、进展卡展开、换轮与新会话。');
} catch (e) {
  console.error(errors, await page?.locator('body').innerText({ timeout: 2000 }).then(s => s.slice(0, 600)).catch(() => ''));
  throw e;
} finally {
  await browser?.close();
}
