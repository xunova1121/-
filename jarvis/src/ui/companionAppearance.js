import './companionRefresh.css';
import './mobileTheme.css';
import './productRefresh.css';
import './focusedComposer.css';
import './homeAndHistory.css';
import { initProductNavigation } from './productNavigation.js';
import { initMobileStartup } from './mobileStartup.js';

/** 只管理布局：键盘出现时让角色退让，阅读旧消息时保留阅读位置。 */
export function initCompanionAppearance(navigation = {}) {
  const body = document.body,
    viewport = window.visualViewport;
  body.classList.add('companion-edition');
  initMobileStartup();
  dispatchEvent(new Event('jarvis:chrome-ready'));
  // Android 旋转、输入框聚焦、键盘缩短视口的通知可能乱序。按布局宽度记住
  // 最近两种方向的完整高度，避免拿横屏的高度判断竖屏键盘。
  let layout = { width: innerWidth, height: innerHeight };
  let previousLayout;
  let keyboardOpen = false;
  const editing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  const resize = () => {
    const height = viewport?.height || innerHeight;
    const focused = editing();
    if (layout.width !== innerWidth) {
      const next = previousLayout?.width === innerWidth ? previousLayout : { width: innerWidth, height: 0 };
      previousLayout = layout;
      layout = next;
    }
    // 点击发送会先让输入框失焦，键盘却尚未收回；此时不能提前展开角色，
    // 否则按钮会在 pointerdown 与 pointerup 之间移位，导致点击丢失。
    // 键盘可能只缩短 visualViewport，也可能连 innerHeight 一起缩短。
    // 编辑中可采纳恢复后的较大布局高度，但不能用键盘已经占用的高度覆盖基线。
    layout.height = focused || keyboardOpen ? Math.max(layout.height, innerHeight) : innerHeight;
    // 双指放大同样会缩小可视高度。按缩放比例换回布局像素，只用来判断键盘。
    const unzoomedHeight = height * (viewport?.scale || 1);
    keyboardOpen = layout.height - unzoomedHeight > 120 && (focused || keyboardOpen);
    body.classList.toggle('wy-keyboard-open', keyboardOpen);
    body.style.setProperty('--wy-viewport-height', `${Math.round(height)}px`);
    body.style.setProperty('--wy-viewport-top', `${Math.round(viewport?.offsetTop || 0)}px`);
  };
  viewport?.addEventListener('resize', resize);
  addEventListener('resize', resize);
  addEventListener('orientationchange', resize);
  document.addEventListener('focusin', resize);
  document.addEventListener('focusout', () => requestAnimationFrame(resize));
  resize();
  if (!body.classList.contains('compact')) return;
  initProductNavigation(navigation);
  const root = document.querySelector('#transcript');
  const jump = Object.assign(document.createElement('button'), { type: 'button', className: 'wy-jump-latest', textContent: '↓ 回到最新回复', hidden: true });
  root.after(jump);
  const update = () => {
    // 还没有任何消息（如智能体起始页）就没有“最新回复”可回
    jump.hidden = !root.querySelector('.msg') || !body.classList.contains('wy-reading-history') || root.scrollHeight - root.scrollTop - root.clientHeight < 160;
  };
  root.addEventListener('scroll', update, { passive: true });
  new MutationObserver(update).observe(root, { childList: true, subtree: true, characterData: true });
  jump.onclick = () => {
    root.scrollTop = root.scrollHeight;
    body.classList.remove('wy-reading-history');
    update();
  };
}
