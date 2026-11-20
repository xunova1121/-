import { createWorkStudioView } from './workStudioView.js';
import './workbenchDesk.css';

function moveNode(parent, node, before = null) {
  // moveBefore 可以保留嵌入式预览和输入焦点，旧内核也沿用同一个 DOM 节点。
  if (parent.moveBefore && node.isConnected && parent.isConnected) parent.moveBefore(node, before);
  else parent.insertBefore(node, before);
}

export function createWorkbenchStudio({ getSession, activity }) {
  const transcript = document.getElementById('transcript');
  const form = document.getElementById('inputbar');
  const main = transcript.parentElement;
  const anchor = document.createComment('conversation');
  main.insertBefore(anchor, transcript);
  const desk = document.createElement('section');
  desk.className = 'wb-desk';
  desk.setAttribute('aria-label', '工作台');
  desk.hidden = true;
  main.insertBefore(desk, anchor);
  const chat = document.createElement('section');
  chat.className = 'wb-desk-chat';
  chat.setAttribute('aria-label', '工作对话');
  const header = document.createElement('header');
  header.className = 'wb-desk-chat-head';
  const heading = document.createElement('h2');
  heading.textContent = '工作对话';
  const title = document.createElement('span');
  title.className = 'wb-desk-chat-title';
  header.append(heading, title);
  const empty = document.createElement('p');
  empty.className = 'wb-desk-empty';
  empty.textContent = '把要做的事告诉未央。';
  chat.append(header, empty);
  desk.append(chat);

  let view;
  let open = false;
  let panelClosed = document.body.classList.contains('side-closed');
  function updateEmpty() {
    if (open) empty.hidden = Boolean(transcript.querySelector('.msg, .wy-agent-start, .wy-studio-start'));
  }
  new MutationObserver(updateEmpty).observe(transcript, { childList: true });

  function refresh() {
    if (!open || !panelClosed || document.hidden) return;
    const session = getSession();
    const label = session?.title || '';
    if (label !== title.textContent) title.textContent = label;
    title.hidden = !label || label === '新对话';
    view.render(activity.snapshot(session));
  }
  function visibility() {
    refresh();
    view?.setVisible(open && panelClosed && !document.hidden);
  }
  new MutationObserver(() => {
    const closed = document.body.classList.contains('side-closed');
    if (closed === panelClosed) return;
    panelClosed = closed;
    visibility();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', visibility);
  activity.subscribe(refresh);

  function show(on) {
    if (open === on) return;
    const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 20;
    const scrollTop = transcript.scrollTop;
    open = on;
    if (open) {
      if (!view) {
        view = createWorkStudioView();
        desk.prepend(view.element);
      }
      desk.hidden = false;
      // 从对话到输入框之间也包含建议、引导队列与回到最新。切换时完整搬入当前节点。
      for (let item = transcript; item;) {
        const next = item.nextElementSibling;
        moveNode(chat, item);
        if (item === form) break;
        item = next;
      }
      updateEmpty();
    } else {
      for (const item of [...chat.children]) {
        if (item !== header && item !== empty) moveNode(main, item, anchor);
      }
      // 归位后将定位点留在桌面布局和普通对话之间。
      main.insertBefore(anchor, transcript);
      desk.hidden = true;
    }
    visibility();
    transcript.scrollTop = atEnd ? transcript.scrollHeight : scrollTop;
  }
  return { show, refresh };
}
