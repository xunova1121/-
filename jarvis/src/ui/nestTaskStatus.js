import { sameTaskReceipt } from '../app/nestTaskDelivery.js';
import './nestTaskStatus.css';

export function createNestTaskStatus(form, studio, options) {
  const line = document.createElement('button');
  line.className = 'nest-task-status';
  line.type = 'button';
  line.hidden = true;
  let receipt, file, lastSnapshot, retryTimer = null, nextAttempt = 0, failures = 0, generation = 0, action = '';
  function resetRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    nextAttempt = failures = 0;
  }
  function reconnect() {
    if (!failures || !lastSnapshot || !studio.isConnected || document.hidden) return;
    nextAttempt = 0;
    update(lastSnapshot);
  }
  function label(value, hint) {
    if (line.textContent !== value) line.textContent = value;
    line.title = hint;
    line.setAttribute('aria-label', hint);
    line.hidden = !value;
  }
  function clear() {
    generation++;
    receipt = file = null;
    action = '';
    lastSnapshot = null;
    resetRetry();
    window.removeEventListener('online', reconnect);
    line.remove();
    line.hidden = true;
  }
  function update(snapshot) {
    options?.refreshPreview?.();
    if (line.parentElement !== form) { form.prepend(line); window.addEventListener('online', reconnect); }
    lastSnapshot = snapshot;
    if (snapshot.active) {
      resetRetry();
      generation++;
      receipt = file = null;
      action = 'steps';
      const row = snapshot.entries.filter(r => r.status === 'running').at(-1) || snapshot.entries.at(-1);
      if (!row) { label('', ''); return; }
      label(row.title + (row.file ? ' · ' + row.file : '') + ' ›', '查看任务步骤');
      return;
    }
    const next = options?.getReceipt?.();
    if (sameTaskReceipt(receipt, next) && action !== 'steps') {
      if (!failures || Date.now() < nextAttempt || action === 'checking') return;
    } else resetRetry();
    const token = ++generation;
    receipt = next;
    file = null;
    action = '';
    label('', '');
    if (!next) return;
    action = 'checking';
    options.readResults(next).then(files => {
      if (generation !== token || !sameTaskReceipt(next, options.getReceipt())) return;
      resetRetry();
      action = '';
      if (!files.length) return;
      file = files[0];
      action = files.length > 1 ? 'folder' : 'file';
      const name = file.path.split('/').pop();
      label(files.length > 1 ? files.length + ' 份任务成品 ›' : '已生成 · ' + name + ' ›', files.length > 1 ? '查看本次任务成品' : '打开成品 ' + name);
    }).catch(() => {
      if (generation !== token) return;
      action = '';
      const delay = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
      nextAttempt = Date.now() + delay;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { if (!document.hidden && lastSnapshot && line.isConnected) update(lastSnapshot); }, delay);
    });
  }
  line.onclick = () => {
    if (action === 'steps') {
      // 在小窝里看步骤：就地展开聊天记录（步骤卡片就在对话里），不再跳到旧的任务工位房间
      // （2026-11-25 用户：刚刚对话出现最早那一版小屋）。没有人接手时才按原来切到任务工位。
      const inNest = studio.querySelector('.ws-scene[data-room-view="nest"]');
      if (inNest && !studio.dispatchEvent(new CustomEvent('nest:show-steps', { cancelable: true }))) return;
      inNest && studio.querySelector('.ws-floor-toggle')?.click();
      const list = studio.querySelector('.ws-list');
      if (list) { list.tabIndex = -1; list.focus({ preventScroll: true }); list.scrollIntoView({ block: 'nearest' }); }
    } else if (receipt && sameTaskReceipt(receipt, options.getReceipt())) {
      if (action === 'folder') studio.querySelector('[data-furniture="folder"]')?.click();
      else if (file) options.useResult(receipt, file, line, false).catch(e => { clear(); options.notify?.(e.message); });
    } else clear();
  };
  return { update, clear };
}
