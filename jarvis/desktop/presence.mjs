/**
 * 在场检测（只看“有没有在用电脑”，不记录任何内容）：
 *   - 键盘鼠标空闲超过 5 分钟，或锁屏 / 睡眠 → 离开
 *   - 离开后又有键盘鼠标操作，或解锁 / 唤醒 → 回来，通知页面（附带离开了多久）
 */
export function createPresence({ powerMonitor, onBack, onAway, awayAfterSec = 300, pollMs = 10000, now = Date.now } = {}) {
  let away = false;
  let awaySince = 0;
  let timer = 0;

  function goAway(reason) {
    if (away) return;
    away = true;
    awaySince = now() - (reason === 'idle' ? awayAfterSec * 1000 : 0);
    onAway?.(reason);
  }
  function comeBack(reason) {
    if (!away) return;
    away = false;
    onBack?.({ awayMs: now() - awaySince, reason });
  }
  function poll() {
    const idle = powerMonitor.getSystemIdleTime();
    if (!away && idle >= awayAfterSec) goAway('idle');
    else if (away && idle < Math.max(2, pollMs / 1000)) comeBack('input');
  }

  const handlers = {
    'lock-screen': () => goAway('lock'),
    suspend: () => goAway('sleep'),
    'unlock-screen': () => comeBack('unlock'),
    resume: () => { /* 唤醒后等第一次键盘鼠标操作再算回来 */ }
  };
  return {
    start() {
      for (const [ev, fn] of Object.entries(handlers)) powerMonitor.on(ev, fn);
      timer = setInterval(poll, pollMs);
    },
    stop() {
      clearInterval(timer);
      for (const [ev, fn] of Object.entries(handlers)) powerMonitor.off?.(ev, fn);
    },
    poll,
    get away() { return away; }
  };
}
