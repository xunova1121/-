/** 2026-11-25 用户：m3u8 现在只支持 https，需要 http 也可以播放 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkshopVideoSource } from '../shared/workshopVideoSource.js';

const ROOT = path.resolve(import.meta.dirname, '..');
describe('http 直播源', () => {
  it('http 和 https 的 m3u8 都能交给播放器，局域网地址和端口也可以', () => {
    expect(parseWorkshopVideoSource('http://tv.example.com/live/cctv1.m3u8')).toEqual({ type: 'media', url: 'http://tv.example.com/live/cctv1.m3u8', format: 'hls' });
    expect(parseWorkshopVideoSource('http://192.168.1.8:8080/hls/index.m3u8?token=1').format).toBe('hls');
    expect(parseWorkshopVideoSource('https://tv.example.com/live/a.m3u8').format).toBe('hls');
    expect(parseWorkshopVideoSource('http://tv.example.com/movie.mp4').format).toBe('video');
  });
  it('仍拒绝账号密码、网页、脚本和其它协议', () => {
    for (const url of ['http://u:p@tv.example.com/a.m3u8', 'http://tv.example.com/player.html', 'http://tv.example.com/a.js',
      'ftp://tv.example.com/a.m3u8', 'rtmp://tv.example.com/live', 'javascript:alert(1)', 'http:tv.example.com/a.m3u8']) {
      expect(() => parseWorkshopVideoSource(url), url).toThrow();
    }
  });
  it('安卓：应用页面是 https://localhost，要允许页面里加载 http 视频，并允许明文 http 连接', () => {
    const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
    expect(cap.android.allowMixedContent).toBe(true);
    const manifest = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toMatch(/<application[^>]*android:usesCleartextTraffic="true"/s);
  });
});
