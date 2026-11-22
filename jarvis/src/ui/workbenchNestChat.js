import './workbenchNestChat.css';

// 小窝借用当前对话的正文、输入框和队列，只切换显示大小。任务工位使用原有的对话布局。
export function createWorkbenchNestChat(desk, chat, transcript, form) {
  const prompt = form.querySelector('#prompt');
  const controls = document.createElement('div');
  controls.className = 'wb-nest-chat-controls';
  const expand = document.createElement('button');
  const hide = document.createElement('button');
  for (const button of [expand, hide]) {
    button.type = 'button';
    button.setAttribute('aria-controls', transcript.id);
    controls.append(button);
  }
  chat.querySelector('header').append(controls);
  let scene, placeholder, mode = 'preview';
  let reading;

  function rememberHistory() {
    reading = {
      top: transcript.scrollTop,
      atEnd: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 24
    };
  }
  function restoreHistory() {
    if (reading) transcript.scrollTop = reading.atEnd ? transcript.scrollHeight : reading.top;
  }
  function setMode(next, selectedMessage) {
    if (mode === 'history') rememberHistory();
    mode = next;
    desk.dataset.deskChat = next;
    expand.textContent = next === 'history' ? '收起全文' : '展开对话';
    expand.setAttribute('aria-expanded', String(next === 'history'));
    hide.textContent = next === 'quiet' ? '显示消息' : '隐藏消息';
    hide.setAttribute('aria-expanded', String(next !== 'quiet'));
    if (next === 'history' && selectedMessage) {
      transcript.scrollTop += selectedMessage.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
    } else if (next === 'history') restoreHistory();
    else if (next === 'preview') transcript.scrollTop = transcript.scrollHeight;
  }
  expand.onclick = () => setMode(mode === 'history' ? 'preview' : 'history');
  hide.onclick = () => setMode(mode === 'quiet' ? 'preview' : 'quiet');
  transcript.addEventListener('click', event => {
    if (desk.dataset.deskChat !== 'preview' || event.target.closest('a,button,input,summary,select') || window.getSelection()?.isCollapsed === false) return;
    const message = event.target.closest('.msg > .body')?.parentElement;
    if (message) setMode('history', message);
  });
  chat.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || mode !== 'history' || !desk.hasAttribute('data-desk-chat')) return;
    // 子菜单拥有自己的 Escape；已经在处理任务时保留原有的全局停止快捷键。
    if (event.defaultPrevented || document.body.classList.contains('generating')) return;
    setMode('preview');
    expand.focus({preventScroll: true});
    event.preventDefault();
    event.stopPropagation();
  });
  function leaveNest() {
    if (placeholder === undefined) return;
    if (mode === 'history') rememberHistory();
    delete desk.dataset.deskChat;
    delete prompt.dataset.nestNews;
    prompt.placeholder = placeholder;
    placeholder = undefined;
    restoreHistory();
  }
  function sync() {
    if (scene.dataset.roomView !== 'nest') { leaveNest(); return; }
    if (placeholder === undefined) {
      placeholder = prompt.placeholder;
      rememberHistory();
      setMode('preview');
    }
    const newsOpen = scene.querySelector('.ws-media-panel[data-device="monitor"]:not([hidden]) .ws-media-actions:not([hidden])') &&
      scene.querySelector('.ws-media-news:not([hidden])');
    prompt.toggleAttribute('data-nest-news', Boolean(newsOpen));
    prompt.placeholder = newsOpen ? '追问这条新闻…' : '和未央说说话…';
  }
  const observer = new MutationObserver(sync);
  // 多行草稿或附件让输入框变高时，把待发列表放在它上方。
  const composerSize = new ResizeObserver(([entry]) => {
    const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
    chat.style.setProperty('--wb-desk-input-height', Math.ceil(height + 6) + 'px');
  });
  return {
    open(view) {
      scene = view.querySelector('.ws-scene');
      observer.observe(scene, { attributes: true, attributeFilter: ['data-room-view'] });
      for (const node of scene.querySelectorAll('.ws-media-panel, .ws-media-news, .ws-media-actions')) {
        observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'data-device'] });
      }
      composerSize.observe(form);
      sync();
    },
    close() { observer.disconnect(); composerSize.disconnect(); leaveNest(); }
  };
}
