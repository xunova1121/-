import { createWorkStudioView } from './workStudioView.js';
import { createConversationMount } from './conversationMount.js';
import './workbenchDesk.css';

export function createWorkbenchStudio({ getSession, activity, newsChat, newsFeed, getPlayers }) {
  const transcript = document.getElementById('transcript');
  const form = document.getElementById('inputbar');
  const main = transcript.parentElement;
  const desk = document.createElement('section');
  desk.className = 'wb-desk';
  desk.setAttribute('aria-label', '工作台');
  desk.hidden = true;
  main.insertBefore(desk, transcript);
  const conversation = createConversationMount(transcript, form);
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
    let restoreScroll;
    open = on;
    if (open) {
      if (!view) {
        view = createWorkStudioView({ workshop: true, newsChat, newsFeed, getPlayers });
        desk.prepend(view.element);
      }
      desk.hidden = false;
      restoreScroll = conversation.moveTo(chat);
      updateEmpty();
    } else {
      restoreScroll = conversation.restore();
      desk.hidden = true;
    }
    visibility();
    restoreScroll?.();
  }
  return { show, refresh };
}
