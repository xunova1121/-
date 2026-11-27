/** APK资源常在首帧前就绪；从已解码、可绘制时播放一轮，而非从HTML解析计时。 */
export function playNativeStartup(splash, { duration = 1600 } = {}) {
  if (document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'as-skip';
    skip.textContent = '跳过';
    splash.removeAttribute('aria-hidden');
    splash.classList.add('native-playing');
    splash.append(skip);
    // Web Animations使用现有CSS帧；不引入视频/WebGL，也不等待远程资源。
    for (const animation of splash.getAnimations?.({ subtree: true }) || []) {
      animation.currentTime = 0;
      animation.play();
    }
    let finished = false;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      skip.removeEventListener('click', finish);
      document.removeEventListener('visibilitychange', visibility);
      globalThis.removeEventListener('jarvis:memory-pressure', finish);
      motion.removeEventListener?.('change', changedMotion);
      skip.remove();
      splash.classList.remove('native-playing');
      resolve();
    };
    const visibility = () => { if (document.hidden) finish(); };
    const changedMotion = () => { if (motion.matches) finish(); };
    const timer = setTimeout(finish, duration);
    skip.addEventListener('click', finish);
    document.addEventListener('visibilitychange', visibility);
    globalThis.addEventListener('jarvis:memory-pressure', finish);
    motion.addEventListener?.('change', changedMotion);
  });
}
