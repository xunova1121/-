/** npm run build:mobile && node e2e/work-studio-mobile.mjs [截图目录] */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTaskFloor } from './workshop-test-view.mjs';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../dist-mobile', import.meta.url));
const base = 'https://weiyang.test';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.wasm': 'application/wasm' };
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true });
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
  await page.clock.install({ time: new Date('2026-11-20T04:15:00Z') });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__jarvis && document.body.classList.contains('compact') && document.querySelector('#app-splash')?.hidden !== false);
  const entry = page.getByRole('button', { name: '看未央工作', exact: true });
  const sheet = page.getByRole('dialog', { name: '未央工作室', exact: true });
  assert.equal(await entry.count(), 0);
  assert.equal(await sheet.count(), 0);

  async function checkRoom({ zoom = 1, archive = false } = {}) {
    const result = await sheet.locator('.ws-floorplan').evaluate(async floor => {
      const scene = floor.closest('.ws-scene');
      const actor = floor.querySelector('.ws-actor');
      const art = new Image();
      art.src = getComputedStyle(floor).backgroundImage.slice(5, -2);
      await art.decode();
      const room = floor.getBoundingClientRect();
      const screen = scene.getBoundingClientRect();
      const person = actor.getBoundingClientRect();
      return {
        art: [art.naturalWidth, art.naturalHeight], zoom: room.width / screen.width,
        fullHeight: room.height / screen.height,
        actorRatio: person.width / room.width,
        station: scene.dataset.station, operation: scene.dataset.operation,
        centerX: (person.left + person.width / 2 - room.left) / room.width,
        visible: person.left >= screen.left - 1 && person.right <= screen.right + 1
          && person.top >= screen.top - 1 && person.bottom <= screen.bottom + 1,
        sprite: getComputedStyle(actor.firstElementChild).backgroundImage
      };
    });
    assert.deepEqual(result.art, [1402, 1122], '使用完整车间原画');
    assert(Math.abs(result.zoom - zoom) < .03 && Math.abs(result.fullHeight - zoom) < .03, '取景等比显示车间');
    assert(result.actorRatio <= .16 && result.visible, '小人和工作台同屏可见');
    if (archive) {
      assert.equal(result.station, 'archive');
      assert.equal(result.operation, 'archive');
      assert(Math.abs(result.centerX - .1755) < .02);
      assert.match(result.sprite, /workshop-actions/, '动作图集已用于柜格前的角色');
    }
  }

  const shotDir = process.argv[2];
  async function shot(name) {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, name) });
  }
  const menu = page.locator('#btn-menu');
  async function visitRoom() {
    await menu.click();
    await page.getByRole('button', { name: '未央工作台', exact: true }).click();
    await sheet.waitFor();
    await openTaskFloor(sheet);
  }
  async function roomAction(command) {
    await sheet.locator('[data-room-action="menu"]').click();
    await sheet.locator(`[data-room-action="${command}"]`).click();
  }
  async function checkLife(activity) {
    const scene = sheet.locator(`.ws-scene[data-life-activity="${activity}"][data-life-pose="${activity}"][data-life-phase="settled"]`);
    await scene.waitFor();
    const pose = scene.locator('.ws-life-pose');
    assert(await pose.isVisible(), '生活姿势可见');
    const quilted = activity === 'sleep' && (await scene.getAttribute('data-winter-quilt')) !== null;
    assert.match(await pose.evaluate(el => getComputedStyle(el).backgroundImage),
      quilted ? /workshop-winter-sleep/ : /workshop-life/, '生活姿势加载与当前场景相符的图集');
    const insideRoom = await pose.evaluate(el => {
      const p = el.getBoundingClientRect();
      const room = el.closest('.ws-scene').getBoundingClientRect();
      return p.width > 20 && p.height > 20 && p.left >= room.left - 1 && p.right <= room.right + 1
        && p.top >= room.top - 1 && p.bottom <= room.bottom + 1;
    });
    assert(insideRoom, '生活角色与道具完整呈现在手机画面中');
  }

  // 同一部手机从当地午饭时间切到夜间，进入时的房间直接按当前时刻显示。
  await visitRoom();
  await checkRoom();
  await checkLife('eat');
  assert.match(await sheet.locator('.ws-action').innerText(), /午饭/);
  await shot('mobile-room-lunch.png');
  const light = sheet.locator('[data-room-action="light"]');
  await light.click();
  await sheet.locator('.ws-scene[data-lamp="on"]').waitFor();
  assert.equal(await light.getAttribute('aria-pressed'), 'true');
  const deskLamp = sheet.getByRole('button', { name: '控制桌上的台灯' });
  await deskLamp.tap();
  await sheet.locator('.ws-scene[data-lamp="off"]').waitFor();
  await deskLamp.tap();
  await sheet.locator('.ws-scene[data-lamp="on"]').waitFor();
  await sheet.getByRole('button', { name: '坐到沙发上休息' }).tap();
  await checkLife('rest');
  await sheet.getByRole('button', { name: '去茶水桌泡咖啡' }).tap();
  await checkLife('coffee');
  await roomAction('coffee');
  await checkLife('coffee');
  await sheet.getByRole('button', { name: '返回对话' }).click();
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.id === 'btn-menu');
  await visitRoom();
  await checkLife('coffee');
  await sheet.locator('.ws-scene[data-lamp="on"]').waitFor();
  await roomAction('lamp-auto');
  await roomAction('auto');
  await checkLife('eat');
  await sheet.getByRole('button', { name: '返回对话' }).click();
  await page.clock.setSystemTime(new Date('2026-11-20T15:15:00Z'));
  await page.reload();
  await page.waitForFunction(() => window.__jarvis && document.querySelector('#app-splash')?.hidden !== false);
  await visitRoom();
  await checkLife('sleep');
  await sheet.locator('.ws-scene[data-lamp="off"]').waitFor();
  await shot('mobile-room-night.png');
  await sheet.getByRole('button', { name: '返回对话' }).click();

  async function send(text) {
    await page.fill('#prompt', text);
    await page.click('#btn-send');
  }

  await send('列出工作区文件');
  await entry.click();
  await sheet.waitFor();
  await openTaskFloor(sheet);
  await sheet.locator('.ws-row').filter({ hasText: '列出文件' }).waitFor();
  await sheet.locator('.ws-row').filter({ hasText: '已完成本轮回复' }).waitFor();
  const bounds = await sheet.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845);
  assert(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await sheet.locator('.ws-row').filter({ hasText: '列出文件' }).click();
  assert.equal(await sheet.locator('.ws-action').textContent(), '列出文件');
  await checkRoom({ archive: true });
  await shot('mobile-studio.png');
  await sheet.getByRole('button', { name: '近看操作' }).click();
  await checkRoom({ archive: true, zoom: 2 });
  await shot('mobile-studio-detail.png');
  await sheet.getByRole('button', { name: '看全景' }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.setViewportSize({ width: 844, height: 390 });
  await checkRoom({ archive: true });
  assert(await sheet.evaluate(el => el.getBoundingClientRect().height <= innerHeight && el.scrollWidth <= el.clientWidth + 1));
  await shot('mobile-studio-landscape.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'day'; });
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
  console.log('手机工作室通过：空会话本地午餐与夜间睡眠、开灯与泡咖啡、返回后保留、全景和两倍近看、真实工具记录、横竖屏、返回焦点、进展卡和换会话。');
} catch (e) {
  console.error(errors, await page?.locator('body').innerText({ timeout: 2000 }).then(s => s.slice(0, 600)).catch(() => ''));
  throw e;
} finally {
  await browser?.close();
}
