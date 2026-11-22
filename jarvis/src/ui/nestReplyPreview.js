import './nestReplyPreview.css';

// 预览只观察最近两条原消息，保留链接、附件、选区以及流式正文的 DOM 身份。
export function createNestReplyPreview(transcript, onReply, onSessionChange) {
  const entries = new Map();
  let active = false, visible = false, expanded, timer;
  let newest, wasStreaming = false, sessionId;
  function historyRendered(event) {
    if (sessionId !== undefined && sessionId !== event.detail) onSessionChange();
    sessionId = event.detail;
    refresh(true);
  }
  function replyArrived(message) {
    if (expanded && expanded !== message) {
      const control = entries.get(expanded).button;
      control.textContent = '收起查看新回复';
      control.setAttribute('data-unread', '');
    }
    onReply();
  }
  const listObserver = new MutationObserver(refresh);
  const sizeObserver = new ResizeObserver(schedule);
  function schedule() {
    if (visible && timer === undefined) timer = setTimeout(measure, 100);
  }
  function measure() {
    timer = undefined;
    if (!visible) return;
    for (const [message, { button }] of entries) {
      if (message === expanded) continue;
      const bodies = message.querySelectorAll(':scope > .body:not(:empty)');
      const body = bodies[bodies.length - 1];
      const extra = message.querySelector(':scope > :not(.body,.who,.meta,.msg-actions,.nest-reply-toggle,.mobile-studio-entry,[hidden])');
      button.hidden = !(extra || bodies.length > 1 || (body && body.scrollHeight > body.clientHeight + 1));
    }
  }
  function collapse() {
    if (!expanded) return false;
    const button = entries.get(expanded)?.button;
    expanded.removeAttribute('data-nest-open');
    expanded.scrollTop = 0;
    expanded = undefined;
    if (button) {
      button.textContent = '展开这条';
      button.removeAttribute('data-unread');
      button.setAttribute('aria-expanded', 'false');
    }
    schedule();
    return true;
  }
  function add(message) {
    const button = document.createElement('button');
    button.type = 'button';
    button.hidden = true;
    button.className = 'nest-reply-toggle';
    button.textContent = '展开这条';
    button.setAttribute('aria-expanded', 'false');
    button.onclick = () => {
      if (expanded === message) { collapse(); return; }
      collapse();
      expanded = message;
      message.setAttribute('data-nest-open', '');
      button.textContent = '收起这条';
      button.setAttribute('aria-expanded', 'true');
      message.scrollTop = 0;
    };
    message.dataset.nestRecent = '';
    message.append(button);
    const observer = new MutationObserver(() => {
      if (button.nextElementSibling) message.append(button);
      if (message === newest && wasStreaming && !message.classList.contains('streaming')) {
        wasStreaming = false;
        replyArrived(message);
      }
      // 已经溢出的流式回复在结束时再度测量；无需逐字计算版面。
      if (button.hidden || !message.classList.contains('streaming')) schedule();
    });
    observer.observe(message, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['class'] });
    entries.set(message, { button, observer });
  }
  function remove(message) {
    if (message === expanded) collapse();
    const { button, observer } = entries.get(message);
    observer.disconnect();
    button.remove();
    delete message.dataset.nestRecent;
    entries.delete(message);
  }
  function refresh(initial = false) {
    if (!active) return;
    const recent = [];
    for (let node = transcript.lastElementChild; node && recent.length < 2; node = node.previousElementSibling) {
      if (node.classList.contains('msg')) recent.push(node);
    }
    for (const message of entries.keys()) if (!recent.includes(message)) remove(message);
    for (const message of recent) if (!entries.has(message)) add(message);
    if (newest !== recent[0]) {
      newest = recent[0];
      wasStreaming = !!newest?.classList.contains('streaming');
      if (initial !== true && newest?.classList.contains('agent')) replyArrived(newest);
    }
    schedule();
  }
  function stop() {
    active = visible = false;
    listObserver.disconnect();
    transcript.removeEventListener('wy:history-rendered', historyRendered);
    sizeObserver.disconnect();
    clearTimeout(timer);
    timer = undefined;
    for (const message of entries.keys()) remove(message);
    newest = undefined;
    wasStreaming = false;
  }
  return {
    collapse, stop,
    returnToLatest() {
      const button = transcript.lastElementChild?.matches('.wy-history-pages')
        && transcript.lastElementChild.querySelector('[data-history-latest]');
      if (button) button.click();
      return !!button;
    },
    start() {
      if (active) return;
      active = true;
      sessionId = transcript.dataset.historySession;
      transcript.addEventListener('wy:history-rendered', historyRendered);
      listObserver.observe(transcript, { childList:true });
      sizeObserver.observe(transcript);
      refresh(true);
    },
    show(next) {
      if (visible === next) return;
      visible = next;
      if (!visible) collapse(); else schedule();
    },
    get expanded() { return expanded; }
  };
}
