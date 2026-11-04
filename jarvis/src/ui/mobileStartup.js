import { playNativeStartup } from './nativeStartup.js';

/** 图片准备有界等待；加载失败时明确使用原始静态标志，不留下透明空头像。 */
async function prepareMascotImages() {
  const images = ['./mascot-approved.webp', './mascot-startup.webp'].map((path) => {
    const image = new Image();
    // 使用静态URL，确保Vite把两张图集打进安装包。
    image.src = path.includes('approved') ? new URL('./mascot-approved.webp', import.meta.url).href : new URL('./mascot-startup.webp', import.meta.url).href;
    return image.decode();
  });
  let timer;
  const loaded = Promise.all(images)
    .then(() => {
      document.body.classList.remove('mascot-unavailable');
      return true;
    })
    .catch(() => false);
  const ready = await Promise.race([
    loaded,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 1500);
    })
  ]);
  clearTimeout(timer);
  document.body.classList.toggle('mascot-unavailable', !ready);
  return ready;
}

/** 原生桥会延迟主模块执行；始终保留浅色启动层，等布局和角色资源就绪再揭开。 */
export function initMobileStartup({ prepareImages = prepareMascotImages, native = document.documentElement.classList.contains('mobile-app') } = {}) {
  const root = document.documentElement;
  const splash = document.getElementById('app-splash');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(globalThis.__jarvisSplashWatchdog);
    splash?.remove();
    dispatchEvent(new Event('jarvis:chrome-ready'));
  };
  if (root.dataset.mode !== 'mobile') {
    finish();
    return Promise.resolve();
  }
  const reveal = (imagesReady) =>
    new Promise((resolve) => {
      // 两帧后再展示，覆盖compact布局切换及首次角色绘制。
      requestAnimationFrame(() =>
        requestAnimationFrame(async () => {
          root.classList.add('mobile-ui-ready');
          clearTimeout(globalThis.__jarvisSplashWatchdog);
          const reduced =
            root.classList.contains('safe-render') ||
            document.body.classList.contains('reduced-motion') ||
            matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (!splash || reduced) {
            finish();
          } else {
            if (native && imagesReady !== false) {
              try { await playNativeStartup(splash); }
              catch { /* 旧WebView动效接口不可用时照常揭开首页，不让启动动画阻断使用。 */ }
            }
            const from = splash.querySelector?.('.as-character')?.getBoundingClientRect();
            const to = document.querySelector?.('.topbar .brand-mark')?.getBoundingClientRect();
            if (from?.width && to?.width) {
              splash.style?.setProperty('--splash-dx', `${to.x + to.width / 2 - from.x - from.width / 2}px`);
              splash.style?.setProperty('--splash-dy', `${to.y + to.height / 2 - from.y - from.height / 2}px`);
              splash.style?.setProperty('--splash-scale', String(to.width / from.width));
            }
            splash.classList.add('out');
            splash.addEventListener('transitionend', finish, { once: true });
            setTimeout(finish, 240);
          }
          resolve();
        })
      );
    });
  return prepareImages().catch(() => {
    document.body.classList.toggle('mascot-unavailable', true);
    return false;
  }).then(reveal);
}
