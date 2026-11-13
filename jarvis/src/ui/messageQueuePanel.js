import './messageQueuePanel.css';

/** 先发送到输入框上方的队列，只有明确“改为引导”才补充当前任务。 */
export function initMessageQueuePanel(form, { current, working, remove, edit, guide, toggle }) {
  const button = (text, click) => {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = text; node.onclick = click;
    return node;
  };
  const box = document.createElement('section');
  box.className = 'composer-message-queue';
  box.setAttribute('aria-label', '待发送问题');
  const header = document.createElement('div');
  const title = document.createElement('span');
  title.setAttribute('role', 'status');
  const hold = button('暂停队列', toggle);
  header.append(title, hold);
  const list = document.createElement('ol');
  box.append(header, list);
  form.before(box);
  const menu = document.createElement('div');
  menu.className = 'composer-queue-menu';
  menu.id = 'composer-queue-actions';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '待发消息操作');
  menu.hidden = true;
  document.body.append(menu);
  let trigger = null;
  const closeMenu = (focus = false) => {
    menu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    if (focus && trigger?.isConnected) trigger.focus();
    trigger = null;
  };
  const icon = (kind) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', { edit: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z', guide: 'M5 5v7a3 3 0 0 0 3 3h11m-4-4 4 4-4 4', cancel: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7', more: 'M12 5h.01M12 12h.01M12 19h.01', queue: 'M5 7h14M5 12h10M5 17h6' }[kind]);
    svg.append(path);
    return svg;
  };
  function openMenu(control, row) {
    const same = trigger === control && !menu.hidden;
    closeMenu();
    if (same) return;
    trigger = control;
    control.setAttribute('aria-expanded', 'true');
    menu.replaceChildren();
    for (const [kind, text, action] of [['edit', '编辑消息', edit], ...(working() ? [['guide', '改为引导', guide]] : []), ['cancel', '取消消息', remove]]) {
      const item = button(text, () => { closeMenu(); action(row.id); });
      item.setAttribute('role', 'menuitem');
      item.dataset.action = kind;
      item.prepend(icon(kind));
      menu.append(item);
    }
    menu.hidden = false;
    const rect = control.getBoundingClientRect();
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.top - height - 6, innerHeight - height - 8))}px`;
    menu.querySelector('button')?.focus();
  }
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !trigger?.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll('button')], at = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
  }, true);
  addEventListener('resize', () => closeMenu());
  let signature = '';
  function refresh() {
    const busy = working();
    const send = form.querySelector('#btn-send');
    send?.setAttribute('aria-label', busy ? '加入问题队列' : '发送');
    const rows = current();
    box.hidden = !rows.length || !form.getClientRects().length;
    if (box.hidden) closeMenu();
    const paused = rows.some(row => row.paused);
    title.textContent = `${paused ? '已暂停 · ' : ''}${rows.length} 条待发消息`;
    hold.textContent = paused || !busy ? '继续队列' : '暂停队列';
    const next = JSON.stringify([busy, rows.map(row => [row.id, row.text, row.busy, row.files.map(file => file.path)])]);
    if (next === signature) return;
    signature = next;
    closeMenu();
    list.replaceChildren();
    for (const row of rows) {
      const li = document.createElement('li');
      li.dataset.queueId = row.id;
      li.classList.toggle('is-sending', Boolean(row.busy));
      const mark = document.createElement('span');
      mark.className = 'composer-queue-mark';
      if (row.busy) mark.textContent = '送达中';
      else mark.append(icon('queue'));
      const text = document.createElement('span');
      text.className = 'composer-queue-text';
      text.textContent = row.text || `附件问题（${row.files.length}个附件）`;
      text.title = row.text;
      const more = button('', () => openMenu(more, row));
      more.setAttribute('aria-label', '待发消息操作');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.setAttribute('aria-controls', menu.id);
      more.disabled = Boolean(row.busy);
      more.append(icon('more'));
      li.append(mark, text, more); list.append(li);
    }
  }
  refresh();
  return { refresh, get mode() { return 'queue'; } };
}
