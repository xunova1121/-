import { createWorkStudioView } from './workStudioView.js';
import './mobileWorkStudio.css';

// 将入口放在当前这轮的工作进展旁，旧消息、旧分页都不挂载入口。
export function initMobileWorkStudio({ getSession, activity }) {
  const transcript = document.getElementById('transcript');
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'mobile-studio-entry';
  entry.textContent = '看未央工作';
  entry.setAttribute('aria-haspopup', 'dialog');
  entry.setAttribute('aria-controls', 'mobile-work-studio');
  const sheet = document.createElement('dialog');
  sheet.id = 'mobile-work-studio';
  sheet.className = 'mobile-studio-sheet';
  sheet.setAttribute('aria-label', '未央工作室');
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'mobile-studio-back';
  back.textContent = '返回对话';
  back.autofocus = true;
  sheet.append(back);
  document.body.append(sheet);
  let view;
  let sessionId;
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
    const snapshot = activity.snapshot(getSession());
    if (!reply || !snapshot.entries.length) {
      entry.remove();
      if (sheet.open) sheet.close();
      return;
    }
    const card = reply.querySelector(':scope > .progress-card');
    if (card) {
      if (card.nextElementSibling !== entry) card.after(entry);
    } else {
      const who = reply.querySelector(':scope > .who');
      if (who && who !== entry.parentNode) who.append(entry);
    }
    if (sheet.open) {
      if (sessionId !== snapshot.sessionId) sheet.close();
      else view.render(snapshot);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(refresh);
  }

  entry.addEventListener('click', () => {
    const snapshot = activity.snapshot(getSession());
    if (!latestReply()?.contains(entry) || !snapshot.entries.length || sheet.open) return;
    if (!view) {
      view = createWorkStudioView();
      sheet.append(view.element);
    }
    sessionId = snapshot.sessionId;
    sheet.showModal();
    view.render(snapshot);
    view.setVisible(true);
  });
  back.addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    const bounds = sheet.getBoundingClientRect();
    if (e.clientY < bounds.top || e.clientY > bounds.bottom || e.clientX < bounds.left || e.clientX > bounds.right) sheet.close();
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 对话页的全局 Esc 会中断任务。在工作室中只退回对话。
    e.stopPropagation();
    e.preventDefault();
    sheet.close();
  });
  sheet.addEventListener('close', () => {
    if (sheet.open) return;
    view?.setVisible(false);
    if (sessionId === getSession()?.id && entry.isConnected) entry.focus({ preventScroll: true });
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
    if (sheet.open) sheet.close();
    view?.setVisible(false);
    entry.remove();
    sheet.remove();
  };
}
