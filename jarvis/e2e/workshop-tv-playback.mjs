import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { checkWorkshopHlsPlayback } from './workshop-hls-playback.mjs';

// APK 从已登录服务器读取获准的频道配置；本机离线状态单独在正常入场时验收。
export async function openMobileCloudRoom({ page, staticDir, openRoom, check }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wy-e2e-tv-'));
  const password = 'workshop-tv-fixture';
  const serverMode = createServerMode({ dataDir, password });
  const server = createServer({ staticDir: path.resolve(staticDir), serverMode, ollama: null });
  try {
    await serverMode.ready;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const response = await page.request.post(url + '/api/server/login', { data: { password } });
    assert(response.ok(), '测试账号应能登录工作台服务器');
    const { token, role, userId } = await response.json();
    await page.addInitScript(settings => {
      if (location.origin === settings.url) localStorage.setItem('jarvis.server.v1', JSON.stringify(settings));
    }, { url, token, role, userId, enabled: true });
    await page.goto(url);
    await page.waitForFunction(() => window.__jarvisServerClient && window.__jarvis?.send);
    await check(await openRoom(page, true));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function playing(page, locator) {
  const handle = await locator.elementHandle({ timeout: 12000 });
  await page.waitForFunction(el => el.videoWidth > 0 && !el.paused && el.currentTime > 0, handle, { timeout: 12000 });
  return handle;
}

async function requireReleased(handle) {
  assert(await handle.evaluate(el => !el.isConnected && el.paused && !el.hasAttribute('src')), '上一段媒体必须停播并清除播放源');
  await handle.dispose();
}

async function checkProgramArea(video, label) {
  const geometry = await video.evaluate(async el => {
    const set = el.closest('.ws-media-receiver');
    await Promise.all((set?.getAnimations() || []).map(animation => animation.finished));
    const stage = el.closest('.ws-scene')?.getBoundingClientRect();
    if (!stage || !el.closest('.ws-media-screen')) return null;
    const rect = el.getBoundingClientRect();
    const scale = Math.min(rect.width / el.videoWidth, rect.height / el.videoHeight);
    const pixels = el.videoWidth * el.videoHeight * scale ** 2;
    const fraction = pixels / (stage.width * stage.height);
    const desk = el.closest('.wb-desk')?.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { fraction, deskFraction: desk && pixels / (desk.width * desk.height), front: top === el,
      stage: [stage.width, stage.height], screen: [rect.width, rect.height] };
  });
  assert(geometry?.front && geometry.fraction > .5, label + ' 节目实际画面须占场景一半以上 ' + JSON.stringify(geometry));
  if (geometry.deskFraction != null) assert(geometry.deskFraction > .5, label + ' 节目实际画面须占宽屏工作台一半以上 ' + JSON.stringify(geometry));
  const desk = geometry.deskFraction == null ? '' : '，占整个工作台 ' + (geometry.deskFraction * 100).toFixed(1) + '%';
  console.log(label + ' 节目占房间 ' + (geometry.fraction * 100).toFixed(1) + '%' + desk);
}

async function actorInk(page, selector, clip, glass) {
  const shown = await page.screenshot({ clip, scale: 'css' });
  const hidden = await page.screenshot({ clip, scale: 'css', style: selector + ' { opacity: 0 !important; }' });
  return page.evaluate(async ({ frames, clip, glass }) => {
    const colors = await Promise.all(frames.map(async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const draw = canvas.getContext('2d');
      draw.drawImage(image, 0, 0);
      image.close();
      return draw.getImageData(0, 0, canvas.width, canvas.height).data;
    }));
    let pixels = 0, left = clip.width, right = 0, top = clip.height, bottom = 0;
    for (let y = 0; y < clip.height; y++) {
      for (let x = 0; x < clip.width; x++) {
        if (x + clip.x >= glass.left - 1 && x + clip.x <= glass.right + 1 &&
            y + clip.y >= glass.top - 1 && y + clip.y <= glass.bottom + 1) continue;
        const i = (y * clip.width + x) * 4;
        const diff = Math.abs(colors[0][i] - colors[1][i]) + Math.abs(colors[0][i+1] - colors[1][i+1]) +
          Math.abs(colors[0][i+2] - colors[1][i+2]);
        if (diff < 45) continue;
        pixels++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return { pixels, width: right - left + 1, height: bottom - top + 1 };
  }, { frames: [shown, hidden].map(frame => frame.toString('base64')), clip, glass });
}

// 角色是透明图集。比较同一帧构图隐藏人物前后的房间像素，排除电视节目自身的变化。
export async function checkTvActor(room, { working = false } = {}) {
  const page = room.page();
  const selector = working ? '.ws-scene:not([data-life-place]) .ws-actor .ws-sprite' :
    '.ws-scene[data-life-pose="tv"][data-life-phase="settled"] .ws-tv-watcher';
  const actor = room.locator(selector);
  await actor.waitFor({ state: 'visible', timeout: 10000 });
  const spectator = room.locator('.ws-tv-watcher');
  if (working) assert(!await spectator.isVisible(), '执行任务时回到工位');
  else assert(!await room.locator('.ws-life-actor').isVisible(), '同一位未央在前景就座后不再重复显示在背景');
  const { clip, glass, sample, feet, edge, receiverRight } = await actor.evaluate((el, working) => {
    const scene = el.closest('.ws-scene');
    const stage = scene.getBoundingClientRect();
    const sprite = el.getBoundingClientRect();
    // 坐姿图集另一侧画了小电视，只取头发和脸，避免把露出的道具算成人物。
    const mirrored = parseFloat(getComputedStyle(el).scale) < 0;
    const left = sprite.left + (working ? 0 : mirrored ? .53 : .07) * sprite.width;
    const top = sprite.top + (working ? 0 : .12) * sprite.height;
    const sample = { width: sprite.width * (working ? 1 : .4), height: sprite.height * (working ? 1 : .46) };
    const x = Math.ceil(Math.max(0, stage.left, left));
    const y = Math.ceil(Math.max(0, stage.top, top));
    const glass = scene.querySelector('.ws-media-screen').getBoundingClientRect();
    const receiver = scene.querySelector('.ws-media-receiver').getBoundingClientRect();
    const controls = scene.querySelector('.ws-media-remote').getBoundingClientRect();
    // 仅取机壳底边以下的椅脚，取样区域止于遥控栏，软影始终保留作为背景。
    const feetX = Math.ceil(Math.max(glass.right + 1, sprite.left, stage.left));
    const feetY = Math.ceil(receiver.bottom + 4);
    const feet = { x: feetX, y: feetY, width: Math.floor(Math.min(stage.right, sprite.right)) - feetX,
      height: Math.floor(Math.min(controls.top, stage.bottom, sprite.bottom)) - feetY };
    return { feet, edge: sprite.left + .46 * sprite.width, receiverRight: receiver.right,
      clip: { x, y, width: Math.floor(Math.min(innerWidth, stage.right, left + sample.width)) - x,
      height: Math.floor(Math.min(innerHeight, stage.bottom, top + sample.height)) - y }, sample,
    glass: glass.toJSON() };
  }, working);
  assert(clip.width > 0 && clip.height > 0, '人物须在现场镜头内 ' + JSON.stringify(clip));
  if (!working) {
    assert(edge >= glass.right - 4 && edge < receiverRight, '角色仅压住右机壳和屏幕最边缘');
    assert(feet.width >= 4 && feet.height >= 2, '电视底边与遥控器间有椅脚落地空间');
    const chair = await actorInk(page, selector, feet, glass);
    assert(chair.pixels >= 8 && chair.width >= 4 && chair.height >= 2,
      '机壳底边以下至少五个像素处能看到真实椅脚 ' + JSON.stringify({ chair, feet }));
  }
  const ink = await actorInk(page, selector, clip, glass);
  const faceVisible = working || (ink.width >= .72 * sample.width && ink.height >= .7 * sample.height &&
    ink.pixels >= .28 * sample.width * sample.height);
  assert(ink.pixels >= 160 && ink.width >= 14 && ink.height >= 18 && faceVisible,
    (working ? '工作' : '观看') + '的真实未央须清晰出现在节目画面之外 ' + JSON.stringify({ ink, clip, glass }));
  console.log((working ? '工作中的未央' : '观看电视的未央头部') + '可见 ' + ink.width + ' × ' + ink.height + ' 像素');
}

// 在真实视频标签播放一段生成的测试图像。测试只拦截许可地址，不连接外部电视或依赖某个节目的版权。
export async function checkWorkshopTvPlayback({ page, context, room, output, platform }) {
  const videoUrl = 'https://media.cctv.com/workshop-fixture.webm';
  const clip = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=12',
    '-t', '8', '-an', '-threads', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1']);
  const config = '**/api/workshop/tv-players';
  await context.route(config, route => route.fulfill({ json: { players: { cctv13: { type: 'media', url: videoUrl } } } }));
  await context.route(videoUrl, route => route.fulfill({ contentType: 'video/webm', body: clip }));
  try {
    const open = room.getByRole('button', { name: '打开电视' });
    const back = room.getByRole('button', { name: '返回房间', exact: true });
    const news = room.getByRole('button', { name: 'CCTV-13 新闻', exact: true });
    const standby = room.locator('.ws-tv-standby video');
    await open.click();
    await room.getByRole('button', { name: 'CCTV-2 财经', exact: true }).click();
    const sample = await playing(page, standby);
    assert.match(await room.locator('.ws-tv-standby').innerText(), /非频道直播|非直播/);
    await checkProgramArea(sample, platform + ' 内置短片');
    await news.click();
    await requireReleased(sample);
    const video = room.locator('.ws-tv-player video');
    const handle = await playing(page, video);
    assert(await handle.evaluate(el => el.videoWidth === 320 && el.videoHeight === 180));
    await checkProgramArea(handle, platform + ' 已配置频道');
    await checkTvActor(room);
    await page.screenshot({ path: path.join(output, platform + '-tv-configured.png') });
    await room.getByRole('button', { name: 'CCTV-2 财经', exact: true }).click();
    await requireReleased(handle);
    await standby.waitFor();
    assert.equal(await room.locator('.ws-tv-player :is(video,iframe)').count(), 0);
    await news.click();
    const beforeClose = await playing(page, video);
    await back.click();
    await requireReleased(beforeClose);
    // 已选择频道后，点实体电视一次即可恢复实际播放；不调用 JS play() 代替用户动作。
    await open.click();
    const reopened = await playing(page, video);
    assert.equal(await news.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await requireReleased(reopened);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const resumed = await playing(page, video);
    await room.getByRole('button', { name: '关闭电视', exact: true }).click();
    await requireReleased(resumed);
    assert(!await room.locator('.ws-media-panel').isVisible(), '关机后回到工作台全景');
  } finally {
    await context.unroute(config);
    await context.unroute(videoUrl);
  }
  await checkWorkshopHlsPlayback({ page, context, room, platform, playing, requireReleased });
}
