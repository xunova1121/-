// 家具的操作放在画面外的原状态行。远眺只替换画面，关闭后归还键盘焦点。
export function createNestPanel(scene, caption, closeOthers, otherPanelOpen) {
  const element = document.createElement('section');
  element.className = 'ws-nest-panel';
  element.hidden = true;
  element.setAttribute('role', 'group');
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'nest-controls-close';
  back.setAttribute('aria-label', '回到房间');
  back.textContent = '×';
  const body = document.createElement('div');
  body.className = 'ws-nest-panel-body';
  element.append(body, back);
  caption.append(element);
  let trigger, vista;
  function close(restoreFocus = true) {
    if (element.hidden) return false;
    element.hidden = true;
    delete caption.dataset.nestControls;
    delete element.dataset.nestPanel;
    vista?.remove();
    vista = null;
    body.replaceChildren();
    if (restoreFocus && trigger?.isConnected) trigger.focus({preventScroll: true});
    trigger = null;
    return true;
  }
  back.onclick = () => close();
  element.onkeydown = event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    close();
  };
  return {
    open(options) {
      closeOthers();
      trigger = options.trigger || trigger;
      vista?.remove();
      vista = options.kind === 'view' ? options.content : null;
      element.setAttribute('aria-label', options.title);
      element.dataset.nestPanel = options.kind;
      caption.dataset.nestControls = options.kind;
      if (vista) scene.append(vista);
      body.replaceChildren(vista ? options.actions : options.content);
      element.hidden = false;
      (body.querySelector('button:not([disabled]):not([hidden])') || back).focus({preventScroll: true});
    },
    close,
    isOpen: kind => kind ? !element.hidden && element.dataset.nestPanel === kind : !element.hidden || otherPanelOpen()
  };
}
