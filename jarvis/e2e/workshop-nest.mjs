/** 正式桌面和手机入口；新闻、浏览器时钟和上传的测试图可复现，草稿、工作区、灯光、播放器均走产品实现。 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { checkNestControls } from './workshop-test-view.mjs';
import { checkLocalWallClock, checkRestingFurniture } from './workshop-room-furniture.mjs';
import { checkProgramArea } from './workshop-tv-playback.mjs';
import { checkCoffee, checkLivingMotion, checkRadio, checkUnobstructed, checkViewingPlace, listenForCat } from './workshop-nest-actions.mjs';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-nest');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.WORKSHOP_CHROMIUM_EXECUTABLE });
const services = [];
const now = (clock, date = '20') => new Date('2026-11-' + date + 'T' + clock + ':00+08:00');
const newsItem = { title: '城市图书馆开放晚间阅读', url: 'https://news.cctv.com/2026/11/20/ARTIworkshoptest.shtml',
  source: '央视网', publishedAt: now('07:00').toISOString() };
const folderFile = '资料/小窝验收旅行笔记.md';

async function host(mobile) {
  const prefix = mobile ? 'MOBILE' : 'PC';
  if (process.env['WORKSHOP_' + prefix + '_URL']) return process.env['WORKSHOP_' + prefix + '_URL'];
  const staticDir = process.env['WORKSHOP_' + prefix + '_DIST'] || (mobile ? 'dist-mobile' : 'dist');
  const server = createServer({ staticDir: path.resolve(staticDir), ollama: null });
  services.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
const pcs = await host(false);
const phones = await host(true);

async function lightLevel(scene) {
  const frame = await loadImage(await scene.screenshot({ scale: 'css', animations: 'disabled' }));
  const canvas = createCanvas(48, 32);
  const graphics = canvas.getContext('2d');
  graphics.drawImage(frame, 0, 0, 48, 32);
  // 人物和桌面占房间中段；顶边灯控和底边标注不作取样。
  const { data } = graphics.getImageData(3, 7, 41, 20);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) total += .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
  return total / (data.length / 4);
}
function framePhoto() {
  const canvas = createCanvas(120, 80), graphics = canvas.getContext('2d');
  graphics.fillStyle = '#05a156'; graphics.fillRect(0, 0, 120, 80);
  graphics.fillStyle = '#ffcc31'; graphics.fillRect(40, 22, 40, 36);
  return canvas.toBuffer('image/png');
}

async function checkRoomLighting(page, scene, hit) {
  const lamp = hit('lamp');
  if ((await lamp.getAttribute('aria-pressed')) !== 'true') await lamp.click();
  await page.waitForTimeout(400);
  const bright = await lightLevel(scene);
  await lamp.click();
  await page.waitForTimeout(450);
  const dark = await lightLevel(scene);
  assert(dark < bright * .74, '拉灯后实际室内亮度应明显降低 ' + JSON.stringify({ bright, dark }));
  await lamp.click();
  return { bright, dark };
}

async function checkWindow(room, hit, shot, closePanel) {
  await hit('window').click();
  await checkUnobstructed(room.locator('.ws-scene'), '调整窗扇');
  const toggleWindow = room.locator('[data-nest-window=toggle]');
  await toggleWindow.click();
  await room.locator('[data-window-state=open]').waitFor({ state: 'attached' });
  await room.locator('[data-nest-window=look]').click();
  const garden = room.locator('.nest-window-view img');
  const dayGarden = await garden.evaluate(async img => { await img.decode(); return img.currentSrc; });
  await shot('开窗远眺');
  await room.locator('[data-nest-window=back]').click();
  await toggleWindow.click();
  await room.locator('[data-window-state=latched]').waitFor({ state: 'attached' });
  await closePanel();
  return dayGarden;
}

async function checkDeskAndPhoto(page, room, hit, button, reloadAt, closePanel, shot) {
  await hit('photo').click();
  await checkUnobstructed(room.locator('.ws-scene'), '更换相框照片');
  const upload = page.waitForEvent('filechooser');
  await room.locator('[data-nest-photo=choose]').click();
  await (await upload).setFiles({ name: '相框测试.png', mimeType: 'image/png', buffer: framePhoto() });
  const photo = room.locator('.nest-wall-photo');
  await photo.waitFor();
  const imageColors = el => el.evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 120, 80);
    return [...ctx.getImageData(60, 40, 1, 1).data, ...ctx.getImageData(15, 15, 1, 1).data];
  });
  const saved = await imageColors(photo);
  assert(saved[0] > 220 && saved[1] > 160 && saved[6] < 120, '还原了自选照片的黄色中心和绿色边缘');
  await closePanel();

  await page.evaluate(name => window.__jarvis.workspace.write(name, '周末乘车进山'), folderFile);
  await hit('folder').click();
  const desk = room.locator('.ws-nest-desk');
  await desk.locator('.ws-nest-file').filter({ hasText: '小窝验收旅行笔记.md' }).waitFor();
  await desk.locator('[data-desk-tab=draft]').click();
  const draft = desk.locator('textarea[aria-label=草稿纸]');
  await draft.fill('准备带上相机和水壶');
  await button(desk, '保存草稿').click();
  await desk.locator('[data-desk-tab=trip]').click();
  await desk.locator('[name=destination]').fill('南京');
  await desk.locator('[name=tripDate]').fill('2026-12-04');
  await desk.locator('[data-trip-item="0"]').setChecked(true);
  await button(desk, '保存行程').click();
  await button(desk, '回到小窝').click();
  await reloadAt('10:48');
  await photo.waitFor();
  assert.deepEqual(await imageColors(photo), saved);
  await hit('photo').click();
  await room.locator('[data-nest-photo=remove]').click();
  await photo.waitFor({ state: 'hidden' });
  await closePanel();
  await hit('draft').click();
  assert.equal(await draft.inputValue(), '准备带上相机和水壶');
  await desk.locator('[data-desk-tab=trip]').click();
  assert.equal(await desk.locator('[name=destination]').inputValue(), '南京');
  assert.equal(await desk.locator('[name=tripDate]').inputValue(), '2026-12-04');
  assert.equal(await desk.locator('[data-trip-item="0"]').isChecked(), true);
  await shot('旅行手账');
  await button(desk, '回到小窝').click();
}

async function checkCat(page, room, scene, hit, waitPose, shot) {
  const output = await listenForCat(page);
  const cat = hit('cat');
  const radio = room.locator('audio.ws-radio-audio');
  await hit('radio').click();
  await page.waitForFunction(() => document.querySelector('.work-studio[data-visible=true] audio.ws-radio-audio')?.currentTime > .05);
  const original = await radio.evaluate(el => ({ volume: el.volume, time: el.currentTime, src: el.currentSrc }));
  await cat.click();
  await room.locator('[data-cat-state="sniff"]').waitFor({ state: 'attached' });
  await checkUnobstructed(scene, '闻手');
  await page.clock.fastForward(3500);
  await room.locator('[data-cat-state="welcome"]').waitFor({ state: 'attached' });
  await page.clock.fastForward(1500);
  await room.locator('[data-cat-state="pet"]').waitFor({ state: 'attached' });
  await waitPose('cat');
  await page.waitForFunction(original => {
    const el = document.querySelector('.work-studio[data-visible=true] audio.ws-radio-audio');
    return !el.paused && el.volume > 0 && el.volume < original / 2;
  }, original.volume);
  await checkUnobstructed(scene, '亲近橘猫');
  await page.waitForFunction(log => log.sounds.some(s => s.voice > .004 && s.meow > .004), output);
  assert.equal(await output.evaluate(log => log.sounds.length), 1, '真实抚摸播放一次语音和回应');
  await shot('亲近橘猫');
  await output.evaluate(log => log.restore());
  await output.dispose();
  await page.waitForFunction(original => {
    const el = document.querySelector('.work-studio[data-visible=true] audio.ws-radio-audio');
    return !el.paused && el.volume === original.volume && el.currentSrc === original.src && el.currentTime > original.time;
  }, original);
  await hit('radio').click();
  for (let i = 0; i < 4 && await scene.getAttribute('data-cat-state') === 'pet'; i++) await cat.click();
  await room.locator('[data-cat-state="rest"]').waitFor({ state: 'attached' });
  await checkUnobstructed(scene, '猫自己休息');
}

async function checkMedia(page, room, button, shot) {
  await room.locator('[data-media-device="monitor"]').click();
  const news = room.locator('.ws-media-panel[data-device=monitor]');
  await news.getByText(newsItem.title, { exact: true }).first().waitFor();
  assert.equal(await news.getByRole('link', { name: '阅读原文', exact: true }).getAttribute('href'), newsItem.url);
  await news.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  await checkViewingPlace(room, 'news');
  await shot('看新闻');
  await button(news, '返回房间').click();
  await room.locator('[data-media-device="tv"]').click();
  const tv = room.locator('.ws-media-panel[data-device=tv]');
  // 老工作区的走路镜头会在开机前几百毫秒把整间小窝移到电视后面。
  // 在等待频道解码之前先验房间位置，以免动作播放完才检查而漏掉这个回归。
  const shift = await room.locator('.ws-scene[data-nest-viewing="tv"]').evaluate(scene =>
    getComputedStyle(scene.querySelector('.ws-floorplan')).translate);
  assert(shift === 'none' || /^0px(?: 0px)?$/.test(shift), '打开电视时房间不应被工作区走路镜头平移 ' + shift);
  await button(tv, 'CCTV-2 财经').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.work-studio[data-visible=true] .ws-tv-standby video');
    return video && video.videoWidth > 0 && !video.paused && video.currentTime > 0;
  });
  await checkProgramArea(tv.locator('.ws-tv-standby video'), '小窝内置节目');
  await room.locator('.ws-scene[data-life-phase="settled"][data-nest-pose="tv"]').waitFor();
  assert.equal(await tv.locator('.ws-tv-watcher').isVisible(), false, '小窝只显示沙发上的一位未央');
  await checkViewingPlace(room, 'tv');
  await shot('看电视');
  await button(tv, '返回房间').click();
}

async function check(mobile, width, clockOnly = false) {
  const home = mobile ? phones : pcs;
  const platform = clockOnly ? 'mobile-local-clock' : mobile ? 'mobile-' + width : 'desktop';
  const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 950 },
    isMobile: mobile, hasTouch: mobile, timezoneId: clockOnly ? 'Asia/Kathmandu' : 'Asia/Shanghai' });
  const errors = [];
  await context.route('https://**/*', route => route.abort());
  await context.route('**/api/workshop/news', route => route.fulfill({ json: { items: [newsItem], updatedAt: +now('08:00'), stale: false } }));
  await context.route('**/cmsdatainterface/page/news_1.jsonp', route => route.fulfill({
    contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' },
    body: 'news(' + JSON.stringify({ data: { list: [{ ...newsItem, focus_date: '2026-11-20 07:00:00' }] } }) + ')'
  }));
  await context.addInitScript(() => {
    localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', autoMemory: false, speechOutput: false }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: now('08:30') });
  const room = page.locator('.work-studio:visible');
  const scene = room.locator('.ws-scene');
  const shot = name => page.screenshot({ path: path.join(output, platform + '-' + name + '.jpg'), type: 'jpeg', quality: 89 });
  const hit = key => room.locator('[data-furniture="' + key + '"]');
  const waitPose = pose => room.locator('.ws-scene[data-nest-pose="' + pose + '"]').waitFor();
  const button = (parent, name) => parent.getByRole('button', { name, exact: true });
  async function enter() {
    await page.waitForFunction(() => window.__jarvis?.send);
    if (mobile) {
      await page.locator('#btn-menu').click();
      await button(page, '未央工作台').click();
    } else await button(page.locator('.wb-tabs'), '工作台').click();
    await room.locator('.ws-scene[data-room-view="nest"]').waitFor();
    await room.locator('img.ws-nest-art').evaluate(img => img.decode());
  }
  async function reloadAt(time, date) {
    await page.clock.setSystemTime(now(time, date));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enter();
  }
  async function closePanel() { await page.keyboard.press('Escape'); }
  try {
    await page.goto(home, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.work-studio:visible').count(), 0);
    await enter();
    if (clockOnly) {
      await checkLocalWallClock(page, scene);
      assert.deepEqual(errors, []);
      console.log(platform, '非整点时区的本机时间、分钟走时和前台校时通过');
      return;
    }
    await waitPose('work');
    const art = room.locator('.ws-nest-art');
    assert.deepEqual(await art.evaluate(img => [img.naturalWidth, img.naturalHeight]), mobile ? [1080, 720] : [1536, 1024]);
    assert(await scene.evaluate(el => el.getBoundingClientRect().width >= 280));
    assert.equal(await page.locator('#inputbar').count(), 1);
    if (mobile) {
      await page.locator('#prompt').fill('旅行时带相机');
      for (const viewport of [{ width: 360, height: 740 }, { width, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        await checkNestControls(page, room);
        assert(await page.locator('#mobile-work-studio').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      }
      await page.setViewportSize({ width, height: 844 });
    }
    await shot('小窝');
    await checkLocalWallClock(page, scene);
    await checkRestingFurniture(room, scene, hit, shot);
    await checkLivingMotion(page, scene);
    const { bright, dark } = await checkRoomLighting(page, scene, hit);
    await checkCoffee(page, room, scene, hit, shot);

    const dayGarden = await checkWindow(room, hit, shot, closePanel);

    await checkDeskAndPhoto(page, room, hit, button, reloadAt, closePanel, shot);

    await checkCat(page, room, scene, hit, waitPose, shot);

    await checkRadio(page, room, scene, hit);

    await checkMedia(page, room, button, shot);

    await room.locator('[data-room-action="menu"]').click();
    await room.locator('[data-room-action="lamp-auto"]').click();
    await reloadAt('23:00');
    await waitPose('sleep');
    await room.locator('[data-nest-light="off"]').waitFor({ state: 'attached' });
    const quilt = room.locator('[data-idle-pose="sleep"] .ws-nest-idle-detail .ws-nest-idle-paint');
    await quilt.waitFor();
    assert(await quilt.evaluate(el => el.getAnimations().some(a => a.playState === 'running' &&
      a.effect.getKeyframes().some(frame => frame.transform && frame.transform !== 'none'))), '睡着时被面应随呼吸起伏');
    await shot('夜里盖被子');
    await hit('window').click();
    await room.locator('[data-nest-window=toggle]').click();
    await room.locator('[data-nest-window=look]').click();
    const nightGarden = await room.locator('.nest-window-view img').evaluate(async img => { await img.decode(); return img.currentSrc; });
    assert.notEqual(dayGarden, nightGarden);
    await closePanel();
    await reloadAt('10:00', '21');
    await waitPose('trip');
    await reloadAt('13:00', '21');
    await hit('cat').click();
    await page.clock.fastForward(2500);
    await room.locator('[data-cat-state="deep"]').waitFor({ state: 'attached' });
    await hit('cat').click();
    assert.equal(await scene.getAttribute('data-cat-state'), 'deep', '睡猫可以继续睡');
    await checkUnobstructed(scene, '猫继续睡觉');
    await reloadAt('18:42');
    await page.clock.fastForward(4000);
    await room.locator('[data-cat-state="rest"]').waitFor({ state: 'attached' });
    assert.notEqual(await scene.getAttribute('data-nest-pose'), 'cat', '猫闻手后拒绝，未央留出距离');
    assert.deepEqual(errors, []);
    console.log(platform, '室内亮度', bright.toFixed(1), '→', dark.toFixed(1), '窗景、相框、草稿、旅行、猫、新闻、电视和当地作息通过');
  } catch (err) {
    await shot('失败').catch(() => {});
    console.error(platform, errors, (await room.innerText({ timeout: 500 }).catch(() => '')).slice(0, 1700));
    throw err;
  } finally { await context.close(); }
}

try {
  if (!process.argv.includes('--mobile')) await check(false, 1440);
  if (!process.argv.includes('--desktop')) {
    await check(true, 390);
    await check(true, 390, true);
  }
} finally {
  await browser.close();
  for (const server of services) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
