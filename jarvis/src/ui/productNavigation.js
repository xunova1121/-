/** 内页返回并入顶栏，沿用原按钮/关闭事件；全部功能继续从原抽屉进入。 */
export function initProductNavigation({ showPanel, closePanel }) {
  if (!showPanel || !closePanel || document.querySelector('.product-page-title')) return;
  const bar = document.querySelector('.topbar');
  const back = document.querySelector('#btn-side-back');
  if (!bar || !back) return;
  back.setAttribute('aria-label', '返回对话');
  back.lastChild.textContent = '返回';
  bar.prepend(back);
  const title = document.createElement('span');
  title.className = 'product-page-title';
  title.setAttribute('role', 'heading');
  title.setAttribute('aria-level', '1');
  bar.insertBefore(title, bar.querySelector('.top-actions'));
  const sync = () => {
    const open = document.body.classList.contains('side-open');
    const panel = document.querySelector('.pane:not([hidden])');
    document.body.classList.toggle('product-page-open', open);
    title.hidden = !open;
    title.textContent = panel?.dataset.pane === 'models' ? '模型设置' : panel?.querySelector('h2')?.textContent || '设置';
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('jarvis:panel', sync);
  addEventListener('pagehide', () => observer.disconnect(), { once: true });
  sync();
}
