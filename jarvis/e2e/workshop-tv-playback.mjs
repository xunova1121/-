import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';

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
    const sample = await playing(page, standby);
    assert.match(await room.locator('.ws-tv-standby').innerText(), /非频道直播|非直播/);
    await checkProgramArea(sample, platform + ' 内置短片');
    await news.click();
    await requireReleased(sample);
    const video = room.locator('.ws-tv-player video');
    const handle = await playing(page, video);
    assert(await handle.evaluate(el => el.videoWidth === 320 && el.videoHeight === 180));
    await checkProgramArea(handle, platform + ' 已配置频道');
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
}
