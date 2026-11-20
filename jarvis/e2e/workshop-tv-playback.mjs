import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// 在真实视频标签播放一段生成的测试图像。测试只拦截许可地址，不连接外部电视或依赖某个节目的版权。
export async function checkWorkshopTvPlayback({ page, context, room }) {
  const videoUrl = 'https://media.cctv.com/workshop-fixture.webm';
  const clip = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x54:r=10',
    '-t', '2', '-an', '-threads', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1']);
  const config = '**/api/workshop/tv-players';
  await context.route(config, route => route.fulfill({ json: { players: { cctv13: { type: 'media', url: videoUrl } } } }));
  await context.route(videoUrl, route => route.fulfill({ contentType: 'video/webm', body: clip }));
  try {
    await room.getByRole('button', { name: '打开电视' }).click();
    await room.getByRole('button', { name: 'CCTV-13 新闻', exact: true }).click();
    const video = room.locator('.ws-tv-player video');
    await video.waitFor();
    const handle = await video.elementHandle();
    await handle.evaluate(el => el.play());
    await page.waitForFunction(el => el.videoWidth === 96 && el.videoHeight === 54 && el.currentTime > 0, handle);
    await room.getByRole('button', { name: 'CCTV-2 财经', exact: true }).click();
    assert(await handle.evaluate(el => !el.isConnected && el.paused && !el.hasAttribute('src')));
    assert.equal(await room.locator('.ws-tv-player :is(video,iframe)').count(), 0);
    await handle.dispose();
    await room.getByRole('button', { name: '返回房间', exact: true }).click();
  } finally {
    await context.unroute(config);
    await context.unroute(videoUrl);
  }
}
