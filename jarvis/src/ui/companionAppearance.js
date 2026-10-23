import './companionRefresh.css';
import './mobileTheme.css';

/** 只管理布局：键盘出现时让角色退让，阅读旧消息时保留阅读位置。 */
export function initCompanionAppearance() {
  const body = document.body,
    viewport = window.visualViewport;
  body.classList.add('companion-edition');
  dispatchEvent(new Event('jarvis:chrome-ready'));
  let fullHeight = viewport?.height || innerHeight;
  let keyboardOpen = false;
  const editing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  const resize = () => {
    const height = viewport?.height || innerHeight;
    // 点击发送会先让输入框失焦，键盘却尚未收回；此时不能提前展开角色，
    // 否则按钮会在 pointerdown 与 pointerup 之间移位，导致点击丢失。
    if (!keyboardOpen && !editing()) fullHeight = height;
    keyboardOpen = fullHeight - height > 120 && (editing() || keyboardOpen);
    body.classList.toggle('wy-keyboard-open', keyboardOpen);
    body.style.setProperty('--wy-viewport-height', `${Math.round(height)}px`);
    body.style.setProperty('--wy-viewport-top', `${Math.round(viewport?.offsetTop || 0)}px`);
  };
  viewport?.addEventListener('resize', resize);
  addEventListener('resize', resize);
  addEventListener('orientationchange', () => {
    fullHeight = viewport?.height || innerHeight;
    resize();
  });
  document.addEventListener('focusin', resize);
  document.addEventListener('focusout', () => requestAnimationFrame(resize));
  resize();
  if (!body.classList.contains('compact')) return;
  const root = document.querySelector('#transcript');
  const jump = Object.assign(document.createElement('button'), { type: 'button', className: 'wy-jump-latest', textContent: '↓ 回到最新回复', hidden: true });
  root.after(jump);
  const update = () => {
    jump.hidden = !body.classList.contains('wy-reading-history') || root.scrollHeight - root.scrollTop - root.clientHeight < 160;
  };
  root.addEventListener('scroll', update, { passive: true });
  new MutationObserver(update).observe(root, { childList: true, subtree: true, characterData: true });
  jump.onclick = () => {
    root.scrollTop = root.scrollHeight;
    body.classList.remove('wy-reading-history');
    update();
  };
}
