import './messageQueuePanel.css';

/** 明确区分补充与新问题，排队内容不会提前混进正在回答的上下文。 */
export function initMessageQueuePanel(form, { current, working, remove, edit, toggle }) {
  const input = form.querySelector('#prompt');
  const modes = document.createElement('div');
  modes.className = 'composer-send-modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '生成中发送方式');
  const button = (text, click) => {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = text; node.onclick = click;
    return node;
  };
  let mode = 'steer';
  const steer = button('补充当前任务', () => { mode = 'steer'; refresh(); input.focus(); });
  const later = button('排队新问题', () => { mode = 'queue'; refresh(); input.focus(); });
  modes.append(steer, later);
  const box = document.createElement('section');
  box.className = 'composer-message-queue';
  box.setAttribute('aria-label', '待发送问题');
  const header = document.createElement('div');
  const title = document.createElement('span');
  const hold = button('暂停队列', toggle);
  header.append(title, hold);
  const list = document.createElement('ol');
  box.append(header, list);
  form.prepend(box, modes);
  let signature = '';
  function refresh() {
    const busy = working();
    modes.hidden = !busy;
    if (!busy) mode = 'steer';
    steer.setAttribute('aria-pressed', String(mode === 'steer'));
    later.setAttribute('aria-pressed', String(mode === 'queue'));
    const send = form.querySelector('#btn-send');
    send?.setAttribute('aria-label', busy ? mode === 'queue' ? '加入问题队列' : '发送补充' : '发送');
    const rows = current();
    box.hidden = !rows.length;
    const paused = rows.some(row => row.paused);
    title.textContent = `${paused ? '已暂停' : '待发送'} · ${rows.length}个问题`;
    hold.textContent = paused || !busy ? '继续队列' : '暂停队列';
    const next = JSON.stringify(rows.map(row => [row.id, row.text, row.files.map(file => file.path)]));
    if (next === signature) return;
    signature = next;
    list.replaceChildren();
    for (const row of rows) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = row.text || `附件问题（${row.files.length}个附件）`;
      text.title = row.text;
      const change = button('编辑', () => edit(row.id));
      const cancel = button('移除', () => remove(row.id));
      li.append(text, change, cancel); list.append(li);
    }
  }
  refresh();
  return { refresh, get mode() { return mode; } };
}
