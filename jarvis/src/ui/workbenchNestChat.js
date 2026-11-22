import './workbenchNestChat.css';
import { createNestReplyPreview } from './nestReplyPreview.js';

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
  let reading, unread = false, mediaOpen = false, mediaQuiet = false;
  const preview = createNestReplyPreview(transcript, () => {
    if (mode === 'quiet' || mediaQuiet) { unread = true; updateControls(); }
  }, () => { unread = false; updateControls(); });
  function updateControls() {
    const quiet = mode === 'quiet' || mediaQuiet;
    desk.toggleAttribute('data-nest-media-quiet', mediaQuiet);
    hide.toggleAttribute('data-unread', unread);
    hide.textContent = quiet ? (unread ? '有新回复，显示消息' : '显示消息') : '隐藏消息';
    hide.setAttribute('aria-expanded', String(!quiet));
    preview.show(mode === 'preview' && !mediaQuiet);
  }

  function rememberHistory() {
    reading = {
      top: transcript.scrollTop,
      atEnd: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 24
    };
  }
  function restoreHistory() {
    if (reading) transcript.scrollTop = reading.atEnd ? transcript.scrollHeight : reading.top;
  }
  function setMode(next) {
    if (mode === 'history') {
      rememberHistory();
      if (preview.returnToLatest()) reading = { atEnd: true };
    }
    mode = next;
    mediaQuiet = unread = false;
    preview.collapse();
    desk.dataset.deskChat = next;
    expand.textContent = next === 'history' ? '收起记录' : '聊天记录';
    expand.setAttribute('aria-expanded', String(next === 'history'));
    updateControls();
    if (next === 'history') restoreHistory();
    else if (next === 'preview') transcript.scrollTop = transcript.scrollHeight;
  }
  expand.onclick = () => setMode(mode === 'history' ? 'preview' : 'history');
  hide.onclick = () => setMode(mode === 'quiet' || mediaQuiet ? 'preview' : 'quiet');
  chat.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || !desk.hasAttribute('data-desk-chat') || (!preview.expanded && mode !== 'history')) return;
    // 子菜单拥有自己的 Escape；已经在处理任务时保留原有的全局停止快捷键。
    if (event.defaultPrevented || document.body.classList.contains('generating') || form.querySelector('.composer-more:not([hidden])')) return;
    if (preview.expanded) {
      const button = preview.expanded.querySelector('.nest-reply-toggle');
      preview.collapse();
      button.focus({preventScroll: true});
    } else {
      setMode('preview');
      expand.focus({preventScroll: true});
    }
    event.preventDefault();
    event.stopPropagation();
  });
  function leaveNest() {
    if (placeholder === undefined) return;
    if (mode === 'history') rememberHistory();
    preview.stop();
    mediaOpen = mediaQuiet = unread = false;
    delete desk.dataset.nestMediaQuiet;
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
      preview.start();
      setMode('preview');
    }
    const media = !!scene.querySelector('.ws-media-panel:not([hidden])');
    if (media !== mediaOpen) {
      mediaOpen = media;
      mediaQuiet = media && mode === 'preview' && !preview.expanded;
      if (!media && mode === 'preview') unread = false;
      updateControls();
    }
    const newsOpen = scene.querySelector('.ws-media-panel[data-device="monitor"]:not([hidden]) .ws-media-actions:not([hidden])') &&
      scene.querySelector('.ws-media-news:not([hidden])');
    prompt.toggleAttribute('data-nest-news', Boolean(newsOpen));
    prompt.placeholder = newsOpen ? '追问这条新闻…' : '和未央说说话…';
  }
  desk.addEventListener('click', event => {
    if (event.target.closest('.ws-media-primary') && (mediaQuiet || mode === 'quiet')) setMode('preview');
  }, true);
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
