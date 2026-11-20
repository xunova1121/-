import './workbenchClassicPreview.css';

export function initWorkbenchClassicPreview(onOpen) {
  const stage = document.getElementById('stage-wrap');
  const theme = document.getElementById('set-theme').closest('.setting');
  const actions = document.createElement('div');
  actions.className = 'pane-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn ghost sm';
  button.textContent = '预览经典舞台';
  button.setAttribute('aria-controls', stage.id);
  button.addEventListener('click', onOpen);
  actions.append(button);
  theme.append(actions);

  return {
    setVisible(on) {
      document.body.classList.toggle('wb-classic-stage', on);
      if (on) {
        stage.tabIndex = -1;
        stage.focus({ preventScroll: true });
      }
    }
  };
}
