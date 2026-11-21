/** 手机正常入口，受控 HLS 故障与真实视频解码。可把 WORKSHOP_MOBILE_DIST 指向签名 APK 解出的 assets/public。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { makePlaylist } from './workshop-hls-playback.mjs';

const root = path.resolve(process.env.WORKSHOP_MOBILE_DIST || 'dist-mobile');
const evidence = process.env.WORKSHOP_TV_EVIDENCE_DIR;
const feed = 'https://live.retrostrange.com/hls/';
const mime = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/mp4' };
const button = (parent, name) => parent.getByRole('button', { name, exact: true });

// 取屏幕上视频中央区域的真实截图。仅检查播放器的 readyState 无法察觉解码后仍黑屏。
async function visibleFrame(page, locator, filename, colorful = false) {
  const video = await locator.elementHandle();
  await page.waitForFunction(el => el.videoWidth > 0 && !el.paused && el.currentTime > 0.25, video);
  const info = await video.evaluate(el => {
    const r = el.getBoundingClientRect();
    const w = r.width * .44, h = r.height * .38;
    return { width: el.videoWidth, height: el.videoHeight, time: el.currentTime, url: el.currentSrc,
      clip: { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h } };
  });
  await page.waitForFunction(({ el, time }) => el.currentTime > time + .2, { el: video, time: info.time });
  const image = await page.screenshot({ clip: info.clip, scale: 'css' });
  if (evidence) await writeFile(path.join(evidence, filename + '.png'), image);
  const pixels = await page.evaluate(async data => {
    const frame = await createImageBitmap(new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(frame, 0, 0, 48, 32); frame.close();
    const buffer = ctx.getImageData(0, 0, 48, 32).data;
    let illuminated = 0, saturated = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const rgb = [buffer[i], buffer[i + 1], buffer[i + 2]];
      const max = Math.max(...rgb);
      if (max > 40) illuminated++;
      if (max - Math.min(...rgb) > 55) saturated++;
    }
    return { illuminated: illuminated / 1536, saturated: saturated / 1536 };
  }, image.toString('base64'));
  assert(pixels.illuminated > .2, '手机屏幕的视频中央持续为黑色 ' + JSON.stringify(pixels));
  if (colorful) assert(pixels.saturated > .24, '屏幕未显示 HLS 测试片的彩色色块 ' + JSON.stringify(pixels));
  return { video, info: { ...info, ...pixels } };
}

async function released(handle) {
  assert(await handle.evaluate(el => !el.isConnected && el.paused && !el.hasAttribute('src')), '离开电视后仍在解码');
  await handle.dispose();
}

async function televisionLayers(room) {
  return room.locator('.ws-scene[data-media-device="tv"]').evaluate(async scene => {
    const seat = scene.querySelector('.ws-nest-portrait-actor');
    await seat.decode();
    const ornaments = '.ws-nest-portrait-actor,.ws-nest-portrait-cat,.ws-nest-living,.ws-nest-cat-motion,.ws-nest-loveseat,.nest-window-drape,.ws-life-pose,.ws-life-steam,.ws-life-notes';
    const animations = Array.from(scene.querySelectorAll(ornaments)).flatMap(el => el.getAnimations({ subtree: true }));
    const style = getComputedStyle(seat);
    return { width: seat.naturalWidth, mask: style.maskImage || style.webkitMaskImage,
      activeAnimations: animations.filter(a => a.playState === 'running').map(a => a.animationName) };
  });
}

async function check(browser, base, safe) {
  const context = await browser.newContext({ isMobile: true, hasTouch: true, timezoneId: 'UTC', viewport: { width: 390, height: 844 } });
  const held = [], requested = [], errors = [];
  const report = { browser: browser.version(), safe };
  try {
    await context.addInitScript(safe => {
      localStorage.setItem('jarvis.renderSafe', String(safe));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false, theme: 'day' }));
    }, safe);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('crash', () => errors.push('renderer crash'));
    const avc = await page.evaluate(() => !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.42c01e"'));
    const files = await makePlaylist(avc);
    let serviceState = 'offline';
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === base) return url.pathname.startsWith('/api/') ? route.fulfill({ status: 404 }) : route.continue();
      if (!url.href.startsWith(feed)) return route.abort();
      const name = path.basename(url.pathname);
      requested.push(name);
      const segment = /^stream(\d+)\.(ts|m4s)$/.exec(name);
      if (serviceState === 'offline' || (serviceState === 'interrupted' && segment && Number(segment[1]) >= 3)) {
        held.push(route);
        return;
      }
      const file = name === 'stream.m3u8' && url.pathname === '/hls/stream.m3u8' ? 'master.m3u8' : name;
      // 主、子清单需不同地址；真实 CDN 的相对清单将落在 /hls/variant/ 下。
      let body = files.get(file);
      if (file === 'master.m3u8') body = body.toString().replace('\nstream.m3u8', '\nvariant/stream.m3u8');
      return body ? route.fulfill({ contentType: mime[path.extname(file)], headers: { 'access-control-allow-origin': '*' }, body })
        : route.fulfill({ status: 404 });
    });
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.send);
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('safe-render')), safe);
    // 此处仅模拟 Android 插件的确认。Chromium 截图独立检验随后渲染的视频内容。
    await page.evaluate(safe => {
      window.__toggleLog = [];
      window.__jarvisRenderHealthPlugin = {
        async setWorkshopDrawing({ active, revision }) {
          window.__toggleLog.push({ active, revision });
          if (active && !window.__drawingConfirmed) await new Promise(resolve => { window.__confirmDrawing = resolve; });
          return { status: 'applied', active, softwareLayer: safe && !active };
        }
      };
    }, safe);
    const room = page.locator('#mobile-work-studio');
    async function openRoom() {
      await page.locator('#btn-menu').click();
      await button(page, '未央工作台').click();
    }
    await openRoom();
    await page.waitForFunction(() => window.__confirmDrawing);
    assert.equal(await room.locator('img.ws-nest-art:visible').count(), 0, '尚未确认切换绘制图层就加载了房间');
    await button(room, '返回对话').click();
    await room.waitFor({ state: 'hidden' });
    await page.evaluate(async () => {
      window.__confirmDrawing();
      delete window.__confirmDrawing;
      await new Promise(requestAnimationFrame);
    });
    assert.equal(await room.locator('img.ws-nest-art').count(), 0, '过期的绘制确认在退回聊天后创建了房间');
    assert(await page.locator('#prompt').isVisible());
    await openRoom();
    await page.waitForFunction(() => window.__confirmDrawing);
    await page.evaluate(() => { window.__drawingConfirmed = true; window.__confirmDrawing(); });
    const art = room.locator('img.ws-nest-art');
    await art.waitFor();
    report.roomArt = await art.evaluate(async img => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; });
    assert.deepEqual(report.roomArt, [810, 1440]);
    await button(room, '打开电视').click();
    const channel = room.locator('[data-channel="retrostrange-tv"]');
    if (await channel.getAttribute('aria-pressed') !== 'true') {
      await button(room, '换台').click();
      await channel.click();
    }
    const feedback = room.locator('.ws-tv-feedback:visible');
    await feedback.getByText('正在连接频道…').waitFor();
    const retry = button(room, '重新连接');
    // 原生 HLS 报告支持却不给帧时，产品会再尝试一次 HLS.js。两条路径都不给清单。
    await retry.waitFor({ timeout: 35000 });
    report.failureMessage = await room.locator('.ws-tv-standby .ws-tv-detail').innerText();
    serviceState = 'interrupted';
    await retry.click();
    await feedback.getByText('正在连接频道…').waitFor();
    const partial = await visibleFrame(page, room.locator('.ws-tv-player video'), 'before-stall-' + safe, true);
    await retry.waitFor({ timeout: 25000 });
    report.stallMessage = await room.locator('.ws-tv-standby .ws-tv-detail').innerText();
    assert.match(report.stallMessage, /停止更新|缓冲超时/);
    await released(partial.video);
    await button(room, '看未央风景短片').click();
    const clip = await visibleFrame(page, room.locator('.ws-tv-standby video'), 'clip-' + safe);
    assert.match(clip.info.url, /meadow-preview.*\.(webm|mp4)/);
    assert.match(await room.locator('.ws-tv-standby').innerText(), /非频道直播/);
    report.clip = clip.info;
    serviceState = 'healthy';
    await button(room, '重试直播').click();
    const streamed = await visibleFrame(page, room.locator('.ws-tv-player video'), 'stream-' + safe, true);
    assert.deepEqual([streamed.info.width, streamed.info.height], [256, 144]);
    assert(requested.some(name => /\.(ts|m4s)$/.test(name)));
    report.stream = streamed.info;
    report.layers = await televisionLayers(room);
    assert(report.layers.width > 100 && report.layers.width < report.roomArt[0], '播放时仅绘制小块人物纹理');
    assert.equal(report.layers.mask, 'none');
    assert.deepEqual(report.layers.activeAnimations, [], '播放时装饰层停止循环渲染');
    await released(clip.video);
    await page.evaluate(() => dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: false } })));
    await released(streamed.video);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.evaluate(() => dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: true } })));
    const resumed = await visibleFrame(page, room.locator('.ws-tv-player video'), 'resumed-' + safe, true);
    assert.deepEqual([resumed.info.width, resumed.info.height], [256, 144]);
    await button(room, '换台').click();
    await button(room, '关闭电视').click();
    await released(resumed.video);
    assert.equal(await room.locator('video[src], iframe').count(), 0);
    const afterClose = requested.length;
    await button(room, '返回对话').click();
    await room.waitFor({ state: 'hidden' });
    await page.fill('#prompt', '今天看了电视');
    // 设到猫自然清醒的上午，避免干扰夜间熟睡的行为规则。此时电视已关闭。
    await page.clock.setFixedTime(new Date('2026-11-20T08:00:00Z'));
    await openRoom();
    assert.equal(await page.inputValue('#prompt'), '今天看了电视');
    await art.waitFor();
    const awakeCat = room.locator('.ws-nest-portrait-cat[data-picture="cat"]');
    await awakeCat.waitFor();
    report.cat = await awakeCat.evaluate(async el => {
      await el.decode();
      const image = el.getBoundingClientRect();
      const floor = el.closest('.ws-floorplan').getBoundingClientRect();
      return { visible: !!(image.width && image.height), width: el.naturalWidth, moving: el.getAnimations().some(a => a.playState === 'running'),
        area: image.width * image.height / (floor.width * floor.height) };
    });
    assert(report.cat.visible && report.cat.width < report.roomArt[0] && report.cat.area <= .08, '猫是一张小的独立裁片');
    if (safe) assert.equal(report.cat.moving, false, '兼容显示的静态猫不循环渲染');
    await room.locator('[data-furniture="cat"]').click();
    await room.locator('[data-cat-state="sniff"]').waitFor({ state: 'attached' });
    await button(room, '返回对话').click();
    await room.waitFor({ state: 'hidden' });
    assert.equal(await page.inputValue('#prompt'), '今天看了电视');
    assert.equal(requested.length, afterClose, '电视关闭后出现了新的频道请求');
    const changes = await page.evaluate(() => window.__toggleLog);
    assert.deepEqual(changes.map(entry => entry.active), [true, false, true, false, true, false, true, false]);
    assert(changes.every((entry, i) => !i || entry.revision > changes[i - 1].revision));
    assert.deepEqual(errors, []);
    report.requests = requested;
    report.drawing = changes;
    console.log(JSON.stringify(report));
    if (evidence) await writeFile(path.join(evidence, 'mobile-tv-' + safe + '.json'), JSON.stringify(report, null, 2));
  } finally {
    await Promise.allSettled(held.map(route => route.abort()));
    await context.close();
  }
}

if (evidence) await mkdir(evidence, { recursive: true });
const server = createServer({ staticDir: root, ollama: null });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.WORKSHOP_CHROMIUM_EXECUTABLE });
  for (const safe of [true, false]) await check(browser, 'http://127.0.0.1:' + server.address().port, safe);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
