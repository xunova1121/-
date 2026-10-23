/** 启动动画只占加载时间；界面准备好后直接淡出，不设置固定播放时长。 */
export function initMobileStartup() {
  const splash = document.getElementById('app-splash');
  if (!splash) return;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    splash.remove();
    dispatchEvent(new Event('jarvis:chrome-ready'));
  };
  const mobile = document.documentElement.dataset.mode === 'mobile';
  const reduced =
    document.documentElement.classList.contains('safe-render') ||
    document.body.classList.contains('reduced-motion') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!mobile || reduced) {
    finish();
    return;
  }
  // 等待一帧让已装配界面完成布局，取消旧版“至少等两秒”的延迟。
  requestAnimationFrame(() => {
    if (!splash.isConnected) return;
    splash.classList.add('out');
    splash.addEventListener('transitionend', finish, { once: true });
    // 后台标签可能不派发过渡事件，保留有界清理兜底。
    setTimeout(finish, 240);
  });
}
