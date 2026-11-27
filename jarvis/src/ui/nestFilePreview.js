// The original viewer keeps its document rendering, downloads and sharing controls.
export function createNestFilePreview(openFile, releasePreview) {
  let active;
  function close() {
    if (!active) return false;
    const { dialog, viewer, anchor, trigger } = active;
    active = null;
    releasePreview();
    dialog.close();
    viewer.hidden = true;
    anchor.replaceWith(viewer);
    dialog.remove();
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
    return true;
  }
  function open(path, trigger, source, current) {
    close();
    if (!current()) return;
    const viewer = document.getElementById('viewer');
    const anchor = document.createComment('workspace file viewer');
    const dialog = document.createElement('dialog');
    dialog.className = 'nest-file-preview';
    dialog.setAttribute('aria-label', '任务成品预览');
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '返回小窝';
    back.className = 'btn sm';
    back.onclick = close;
    viewer.before(anchor);
    dialog.append(back, viewer);
    (trigger.closest('#mobile-work-studio, .wb-desk') || document.body).append(dialog);
    active = { dialog, viewer, anchor, trigger, current };
    dialog.oncancel = e => { e.preventDefault(); close(); };
    dialog.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    dialog.showModal();
    void openFile(path, source, () => active?.dialog === dialog && current());
  }
  return { open, close, refresh() { if (active && !active.current()) close(); } };
}
