/**
 * Service Worker：只为了两件事。
 *   ① 「添加到主屏幕」需要它存在（浏览器的安装条件之一）；
 *   ② 壳子（HTML/CSS/JS）离线也能打开，不至于点开是一片空白。
 *
 * ⚠ 刻意**不缓存任何 /api 和 /media**：
 * 缓存了就会出现"手机上看到的还是上一轮的图"，而这一端的全部价值就是
 * 看当前进度。宁可没网时报错，也不能给一个看起来对、其实是旧的答案。
 */
const SHELL = 'fd-m-shell-v1';
const FILES = ['/m', '/m/m.css', '/m/m.js', '/m/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 数据一律走网络，不碰缓存
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/media')) return;
  if (!url.pathname.startsWith('/m')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/m')))
  );
});
