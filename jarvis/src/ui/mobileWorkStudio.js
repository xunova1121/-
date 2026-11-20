import { createWorkStudioView } from './workStudioView.js';
import { createConversationMount } from './conversationMount.js';
import './mobileWorkStudio.css';

// 从菜单可随时看房间；当前回复旁的快捷入口只回看这一轮。
export function initMobileWorkStudio({ getSession, activity, closeDrawer }) {
  const transcript = document.getElementById('transcript');
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'mobile-studio-entry';
  entry.textContent = '看未央工作';
  entry.setAttribute('aria-haspopup', 'dialog');
  entry.setAttribute('aria-controls', 'mobile-work-studio');
  const roomEntry = document.createElement('button');
  roomEntry.type = 'button';
  roomEntry.className = 'drawer-studio-entry';
  roomEntry.textContent = '工作台';
  roomEntry.setAttribute('aria-label', '未央工作台');
  roomEntry.setAttribute('aria-haspopup', 'dialog');
  roomEntry.setAttribute('aria-controls', 'mobile-work-studio');
  document.querySelector('#drawer .drawer-close')?.before(roomEntry);
  const sheet = document.createElement('dialog');
  sheet.id = 'mobile-work-studio';
  sheet.className = 'mobile-studio-sheet';
  sheet.setAttribute('aria-label', '未央工作室');
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'mobile-studio-back';
  back.setAttribute('aria-label', '返回对话');
  back.title = '返回对话';
  back.autofocus = true;
  const chat = document.createElement('section');
  chat.className = 'mobile-studio-chat';
  chat.setAttribute('aria-label', '工作对话');
  const heading = document.createElement('header');
  heading.className = 'mobile-studio-chat-head';
  const label = document.createElement('h2');
  label.textContent = '工作对话';
  const title = document.createElement('span');
  const empty = document.createElement('p');
  empty.className = 'mobile-studio-empty';
  empty.textContent = '交给未央一个任务。';
  heading.append(label, title);
  chat.append(heading, empty);
  sheet.append(chat);
  const conversation = createConversationMount(transcript, document.getElementById('inputbar'));
  const appElement = document.querySelector('.app');
  document.body.append(sheet);
  let view;
  let sessionId;
  let fromReply = false;
  let scheduled = false;
  let disposed = false;

  function latestReply() {
    if (transcript.lastElementChild?.classList.contains('wy-history-pages')) return null;
    const messages = transcript.querySelectorAll(':scope > .msg');
    const last = messages[messages.length - 1];
    return last?.classList.contains('agent') ? last : null;
  }

  function refresh() {
    scheduled = false;
    if (disposed) return;
    const reply = latestReply();
    const session = getSession();
    const snapshot = activity.snapshot(session);
    const hasReply = Boolean(reply && snapshot.entries.length);
    if (hasReply) {
      const card = reply.querySelector(':scope > .progress-card');
      if (card) {
        if (card.nextElementSibling !== entry) card.after(entry);
      } else {
        const who = reply.querySelector(':scope > .who');
        if (who && who !== entry.parentNode) who.append(entry);
      }
    } else entry.remove();
    if (sheet.open) {
      if (sessionId !== snapshot.sessionId) { exitStudio(); return; }
      const name = session?.title || '';
      title.textContent = name === '新对话' ? '' : name;
      empty.hidden = Boolean(transcript.querySelector('.msg, .wy-history-pages, .wy-agent-start, .wy-studio-start'));
      view.render(snapshot);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(refresh);
  }

  function open(viaReply) {
    const snapshot = activity.snapshot(getSession());
    if (sheet.open || (viaReply && (!latestReply()?.contains(entry) || !snapshot.entries.length))) return;
    fromReply = viaReply;
    if (!fromReply) closeDrawer();
    if (!view) {
      view = createWorkStudioView({ workshop: true });
      sheet.prepend(view.element);
      view.element.querySelector('.ws-header').prepend(back);
    }
    sessionId = snapshot.sessionId;
    // 这是完整的工作页面。模型选择与队列菜单使用原有的 body 弹层，继续盖在工作台上。
    sheet.show();
    const restoreScroll = conversation.moveTo(chat);
    appElement.inert = true;
    refresh();
    view.setVisible(true);
    back.focus({ preventScroll: true });
    restoreScroll?.();
  }
  entry.addEventListener('click', () => open(true));
  roomEntry.addEventListener('click', () => open(false));
  back.addEventListener('click', exitStudio);
  function closeInnerMenu() {
    const control = document.querySelector('.ml-picker:not([hidden]) .ml-dismiss, .mp-sheet:not([hidden]) .x-btn')
      || chat.querySelector('[aria-controls="composer-queue-actions"][aria-expanded="true"], #btn-attach[aria-expanded="true"]')
      || sheet.querySelector('[data-room-action="menu"][aria-expanded="true"]');
    if (control) { control.click(); return true; }
    if (chat.querySelector('.quick-menu')) { chat.querySelector('#btn-quick').click(); return true; }
    return false;
  }
  function backInRoom() {
    if (closeInnerMenu()) return;
    if (document.body.classList.contains('wy-keyboard-open') && document.activeElement?.matches('#prompt')) {
      document.activeElement.blur();
      return;
    }
    exitStudio();
  }
  sheet.addEventListener('cancel', (e) => { e.preventDefault(); backInRoom(); });
  // 模型/队列菜单挂在 body，硬键盘 Esc 也要先交给最上层，避免全局快捷键打断任务。
  const overlayEscape = (e) => {
    if (sheet.open && e.key === 'Escape' && !sheet.contains(e.target) && !e.target.closest?.('dialog[open]') && closeInnerMenu()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  document.addEventListener('keydown', overlayEscape, true);
  sheet.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 对话页的全局 Esc 会中断任务。在工作台中逐层退回。
    e.stopPropagation();
    e.preventDefault();
    backInRoom();
  });
  const closeForPanel = () => { if (sheet.open && document.body.classList.contains('side-open')) exitStudio(); };
  window.addEventListener('jarvis:panel', closeForPanel);
  function leave() {
    appElement.inert = false;
    const restoreScroll = conversation.restore();
    view?.setVisible(false);
    restoreScroll?.();
  }
  function exitStudio() {
    leave();
    sheet.close();
  }
  sheet.addEventListener('close', () => {
    if (sheet.open || disposed) return;
    leave();
    const target = fromReply && entry.isConnected ? entry : document.getElementById('btn-menu');
    if (sessionId === getSession()?.id && !document.body.classList.contains('side-open')) target?.focus({ preventScroll: true });
    sessionId = null;
  });
  // 真机切后台时停止回放；返回前台后拉取已在内存中的最新步骤。
  const foreground = (e) => {
    if (!sheet.open) return;
    view.setVisible(e.detail?.active !== false);
    if (e.detail?.active !== false) schedule();
  };
  window.addEventListener('jarvis:foreground', foreground);
  const observer = new MutationObserver(schedule);
  observer.observe(transcript, { childList: true });
  const unsubscribe = activity.subscribe(schedule);
  refresh();
  return () => {
    disposed = true;
    observer.disconnect();
    unsubscribe();
    window.removeEventListener('jarvis:foreground', foreground);
    window.removeEventListener('jarvis:panel', closeForPanel);
    document.removeEventListener('keydown', overlayEscape, true);
    if (sheet.open) sheet.close();
    leave();
    entry.remove();
    roomEntry.remove();
    sheet.remove();
  };
}
