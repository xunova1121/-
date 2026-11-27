// 自定义源只会交给浏览器的视频播放器，不加载第三方网页或脚本。
export function parseWorkshopVideoSource(address, format = 'auto') {
  const raw = typeof address === 'string' ? address.trim() : '';
  let url;
  try { url = new URL(raw); } catch { /* 统一提供面向用户的提示。 */ }
  // 2026-11-25 用户：很多直播源只有 http 的 m3u8，也要能播。只接受完整写出的 http(s)://，仍不允许账号密码。
  if (!url || !/^https?:\/\//i.test(raw) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      raw.length > 4096 || /[\s\\]/u.test(raw)) {
    throw new Error('请填入完整的 HTTP 或 HTTPS 视频直链，地址中不能包含用户名或密码。');
  }
  if (!['auto', 'hls', 'video'].includes(format)) throw new Error('请选择 HLS 或视频格式。');
  const path = url.pathname;
  const hls = /\.m3u8$/i.test(path);
  const video = /\.(?:mp4|m4v|webm|mov|ogv|ogg)$/i.test(path);
  if (/\.(?:s?html?|xhtml|js|mjs|svg|json|m3u|mpd)$/i.test(path)) {
    throw new Error('请填写 M3U8 或视频文件的播放地址。');
  }
  // 直播服务也会用无后缀地址、查询参数和临时签名发布播放清单。
  return { type: 'media', url: url.href, format: hls ? 'hls' : video ? 'video' : format === 'auto' ? 'hls' : format };
}
