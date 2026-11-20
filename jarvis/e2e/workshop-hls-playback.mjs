import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 系统 Chromium 可解码 AVC/TS；Playwright 的自由编解码器构建用 VP9/fMP4 验证同一 HLS 播放链路。
async function makePlaylist(avc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wy-hls-'));
  try {
    const codec = avc ? ['-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-preset', 'ultrafast', '-sc_threshold', '0'] :
      ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6'];
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=256x144:r=12', '-t', '6', '-an',
      ...codec, '-threads', '1', '-g', '12', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
      ...(avc ? [] : ['-hls_segment_type', 'fmp4']), 'stream.m3u8'], { cwd: dir });
    const files = new Map();
    for (const name of await readdir(dir)) files.set(name, await readFile(path.join(dir, name)));
    const profile = avc ? 'avc1.42c01e' : 'vp09.00.10.08';
    files.set('master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=256x144,CODECS="' + profile + '"\nstream.m3u8\n');
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkWorkshopHlsPlayback({ page, context, room, platform, playing, requireReleased }) {
  const avc = await page.evaluate(() => !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.42c01e"'));
  const files = await makePlaylist(avc);
  const base = 'https://media.cctv.com/workshop-hls-fixture/';
  const config = '**/api/workshop/tv-players';
  const feed = base + '**';
  const fetched = new Set();
  const mime = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/mp4' };
  await context.route(config, route => route.fulfill({ json: { players: { cctv9: { type: 'media', url: base + 'master.m3u8' } } } }));
  await context.route(feed, route => {
    const name = path.basename(new URL(route.request().url()).pathname);
    fetched.add(name);
    return files.has(name) ? route.fulfill({ contentType: mime[path.extname(name)], headers: { 'access-control-allow-origin': '*' },
      body: files.get(name) }) : route.fulfill({ status: 404 });
  });
  try {
    const documentary = room.getByRole('button', { name: 'CCTV-9 纪录', exact: true });
    const player = room.locator('.ws-tv-player video');
    await room.getByRole('button', { name: '打开电视' }).click();
    await documentary.click();
    const first = await playing(page, player);
    const state = await first.evaluate(v => ({
      width: v.videoWidth, height: v.videoHeight, time: v.currentTime, mse: v.currentSrc.startsWith('blob:')
    }));
    assert.deepEqual([state.width, state.height], [256, 144], '应由真实 HLS 分片解码出测试画面');
    await page.waitForFunction(({ video, start }) => !video.paused && video.currentTime > start + .25, { video: first, start: state.time });
    assert(fetched.has('master.m3u8') && fetched.has('stream.m3u8') && [...fetched].some(name => /\.(ts|m4s)$/.test(name)),
      '播放器应取回主清单、码率清单和视频分片');
    await room.getByRole('button', { name: 'CCTV-2 财经', exact: true }).click();
    await requireReleased(first);
    await documentary.click();
    const reopened = await playing(page, player);
    await room.getByRole('button', { name: '关闭电视', exact: true }).click();
    await requireReleased(reopened);
    assert(!await room.locator('.ws-media-panel').isVisible());
    console.log(platform + ' HLS ' + (avc ? 'AVC/TS' : 'VP9/fMP4') + ' ' + (state.mse ? 'MSE' : '原生') + ' 解码、换台、关机通过');
  } finally {
    await context.unroute(feed);
    await context.unroute(config);
  }
}
