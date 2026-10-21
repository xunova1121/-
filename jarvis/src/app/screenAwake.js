/**
 * 屏幕常亮：按 core/screenAwake.js 的规则，未央说话时不让屏幕灭，久不碰手机就调暗。
 *   - 说话 = 界面上有 speaking（正在朗读）或 voice-on（开着语音对话），不用改语音模块
 *   - 安卓：原生插件 KeepAwake（保持亮屏 + 只调暗本窗口）；电脑版：主进程阻止显示器休眠；
 *     网页：浏览器的屏幕唤醒锁（不支持就算了）
 *   - 调暗时盖一层黑幕，写着未央在说话，点一下恢复
 */
import { screenPlan, SCREEN_MODES } from '../core/screenAwake.js';
import { $, body, DESKTOP } from './env.js';
import { MOBILE } from '../config.js';

export function createScreenAwake(app) {
  let lastTouch = Date.now();
  let state = { keep: false, dim: false };
  let lock = null; // 网页的唤醒锁
  let force = false; // 切回前台后重新下发一次（网页唤醒锁会被收回）
  const native = MOBILE ? (globalThis.__jarvisKeepAwake ?? null) : null;

  const veil = Object.assign(document.createElement('div'), { className: 'screen-veil', hidden: true });
  veil.append(Object.assign(document.createElement('span'), { textContent: '未央正在说话 · 点一下恢复亮度' }));
  body.append(veil);

  /** 让屏幕保持亮着 / 放开：各端用各自的办法，失败了不影响别的功能 */
  async function keepOn(on) {
    try {
      if (native) return;
      if (DESKTOP) {
        await DESKTOP.invoke('keepScreenOn', { on });
        return;
      }
      if (on && !lock && navigator.wakeLock) lock = await navigator.wakeLock.request('screen');
      if (!on && lock) {
        await lock.release();
        lock = null;
      }
    } catch {
      lock = null; // 浏览器不给（不是 https、省电模式）：照旧跟随系统
    }
  }

  function apply(next) {
    const changed = force || next.keep !== state.keep || next.dim !== state.dim;
    force = false;
    state = next;
    if (!changed) return;
    if (native) native.set({ keep: next.keep, dim: next.dim }).catch(() => {});
    else keepOn(next.keep);
    veil.hidden = !next.dim;
    body.classList.toggle('screen-dim', next.dim);
  }

  function tick() {
    apply(
      screenPlan({
        mode: app.settings.screenAwake,
        talking: body.classList.contains('speaking') || body.classList.contains('voice-on'),
        idleMs: Date.now() - lastTouch,
        foreground: !document.hidden
      })
    );
  }

  const touched = () => {
    lastTouch = Date.now();
    if (state.dim) tick();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) addEventListener(ev, touched, { capture: true, passive: true });
  // 网页的唤醒锁切到后台会被浏览器收回，回来时重新申请
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lock = null;
    force = true;
    tick();
  });
  new MutationObserver(tick).observe(body, { attributes: true, attributeFilter: ['class'] });
  setInterval(tick, 1000);

  const select = $('#set-screen');
  if (select) {
    select.value = SCREEN_MODES.includes(app.settings.screenAwake) ? app.settings.screenAwake : 'smart';
    select.addEventListener('change', (e) => {
      app.setSetting('screenAwake', e.target.value);
      tick();
    });
  }
  tick();
  return { screenState: () => ({ ...state }) };
}
