// 相框和窗景与房间共用一个对话框，切换家具时归还键盘焦点。
export function createNestPanel(scene, closeOthers, otherPanelOpen) {
  const element = document.createElement('section');
  element.className = 'ws-nest-panel';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  const header = document.createElement('header');
  const heading = document.createElement('h3');
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = '回到房间';
  const body = document.createElement('div');
  body.className = 'ws-nest-panel-body';
  header.append(heading, back);
  element.append(header, body);
  scene.append(element);
  let trigger;
  function close(restoreFocus = true) {
    if (element.hidden) return false;
    element.hidden = true;
    delete element.dataset.nestPanel;
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
      heading.textContent = options.title;
      element.setAttribute('aria-label', options.title);
      element.dataset.nestPanel = options.kind;
      body.replaceChildren(options.content);
      element.hidden = false;
      back.focus({preventScroll: true});
    },
    close,
    isOpen: kind => kind ? !element.hidden && element.dataset.nestPanel === kind : !element.hidden || otherPanelOpen()
  };
}
