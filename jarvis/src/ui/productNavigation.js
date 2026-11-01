/** 只连接原有页面入口，不复制配置、任务或会话状态。 */
export function initProductNavigation({ showPanel, closePanel }) {
  if (!showPanel || !closePanel || document.querySelector('.product-navigation')) return;
  const nav = document.createElement('nav');
  nav.className = 'product-navigation';
  nav.setAttribute('aria-label', '主要页面');
  const entries = [
    ['chat', '对话', 'M4 4h16v12H9l-5 4z', closePanel],
    ['workspace', '工作区', 'M3 6h7l2 2h9v12H3z', () => showPanel('workspace')],
    ['settings', '我的', 'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0M4 21v-2a8 8 0 0 1 16 0v2', () => showPanel('settings')]
  ];
  for (const [id, label, path, action] of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.page = id;
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg><span>${label}</span>`;
    button.onclick = action;
    nav.append(button);
  }
  document.body.append(nav);
  const sync = () => {
    const closed = !document.body.classList.contains('side-open');
    const panel = document.querySelector('.pane:not([hidden])')?.dataset.pane;
    const selected = closed ? 'chat' : panel === 'workspace' ? 'workspace' : 'settings';
    for (const button of nav.children) {
      if (button.dataset.page === selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('jarvis:panel', sync);
  addEventListener('pagehide', () => observer.disconnect(), { once: true });
  sync();
}
