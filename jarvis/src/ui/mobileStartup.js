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
}

/** 原生桥会延迟主模块执行；始终保留浅色启动层，等布局和角色资源就绪再揭开。 */
export function initMobileStartup({ prepareImages = prepareMascotImages } = {}) {
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
  const reveal = () =>
    new Promise((resolve) => {
      // 两帧后再展示，覆盖compact布局切换及首次角色绘制。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          root.classList.add('mobile-ui-ready');
          const reduced =
            root.classList.contains('safe-render') ||
            document.body.classList.contains('reduced-motion') ||
            matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (!splash || reduced) {
            finish();
          } else {
            splash.classList.add('out');
            splash.addEventListener('transitionend', finish, { once: true });
            setTimeout(finish, 240);
          }
          resolve();
        })
      );
    });
  return prepareImages().then(reveal);
}
