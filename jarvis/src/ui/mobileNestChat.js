import './mobileNestChat.css';
import { createNestReplyPreview } from './nestReplyPreview.js';

// 只标记当前两条原消息；流式文字、附件、工具记录和历史滚动均使用原来的节点。
export function createMobileNestChat(sheet, chat, transcript) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nest-chat-toggle';
  toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20.5 11.5c0 4.5-3.9 8-8.7 8-1.3 0-2.5-.2-3.7-.7L4 20l1.2-3.7a7.5 7.5 0 0 1-2-4.8c0-4.4 3.8-8 8.6-8s8.7 3.6 8.7 8Z"/><path d="M7.5 11.5h.2m4-.01h.2m4-.01h.2" stroke-width="2" stroke-linecap="round"/></svg>';
  chat.id = 'nest-room-conversation';
  toggle.setAttribute('aria-controls', chat.id);
  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'nest-chat-collapse';
  collapse.textContent = '收起记录';
  chat.querySelector('header').append(collapse);
  const prompt = document.getElementById('prompt');
  let previousPlaceholder;
  let unread = false, mediaOpen = false, mediaQuiet = false;
  let scene;
  let caption, roomMenu, roomMenuButton, viewControls;
  let mode = 'preview';
  let readingPosition;
  const preview = createNestReplyPreview(transcript, () => {
    if (mode === 'hidden' || mediaQuiet) { unread = true; updateControls(); }
  }, () => { unread = false; updateControls(); });
  function updateControls() {
    const quiet = mode === 'hidden' || mediaQuiet;
    sheet.toggleAttribute('data-nest-media-quiet', mediaQuiet);
    toggle.toggleAttribute('data-unread', unread);
    toggle.setAttribute('aria-label', quiet ? (unread ? '有新回复，展开对话' : '展开对话') : '隐藏对话');
    toggle.setAttribute('aria-expanded', String(!quiet));
    preview.show(mode === 'preview' && !mediaQuiet);
  }
  function rememberPosition() {
    const top = transcript.scrollTop;
    const following = transcript.scrollHeight - top - transcript.clientHeight < 20;
    readingPosition = () => { transcript.scrollTop = following ? transcript.scrollHeight : top; };
  }
  const reading = () => scene?.querySelector('.ws-media-panel[data-device="monitor"]:not([hidden]) .ws-media-actions:not([hidden])')
    && scene.querySelector('.ws-media-news:not([hidden])');
  function setMode(next) {
    if (mode === 'history') {
      rememberPosition();
      if (preview.returnToLatest()) readingPosition = () => { transcript.scrollTop = transcript.scrollHeight; };
    }
    mode = next;
    sheet.dataset.nestChat = mode;
    unread = mediaQuiet = false;
    preview.collapse();
    updateControls();
  }
  function fitMenu() {
    const bottom = (mode === 'hidden' ? sheet : chat).getBoundingClientRect();
    const room = (mode === 'hidden' ? bottom.bottom : bottom.top) - roomMenu.getBoundingClientRect().top - 6;
    roomMenu.style.setProperty('--nest-menu-space', Math.max(44, Math.floor(room)) + 'px');
  }
  const menuSize = new ResizeObserver(fitMenu);
  function sync() {
    const immersive = sheet.open && scene?.dataset.nestLayout === 'portrait' && scene.dataset.roomView === 'nest';
    const previous = sheet.hasAttribute('data-nest-immersive');
    if (immersive && !previous) { rememberPosition(); preview.start(); updateControls(); }
    sheet.toggleAttribute('data-nest-immersive', Boolean(immersive));
    const controlHost = immersive ? roomMenu : caption;
    if (viewControls[0].parentElement !== controlHost) controlHost.append(...viewControls);
    if (immersive && !roomMenu.hidden) {
      fitMenu();
      menuSize.observe(chat);
      menuSize.observe(sheet);
    } else menuSize.disconnect();
    if (!immersive) {
      if (previous) { preview.stop(); mediaOpen = unread = mediaQuiet = false; }
      if (previous && mode !== 'history') readingPosition?.();
      if (previousPlaceholder !== undefined) prompt.placeholder = previousPlaceholder;
      previousPlaceholder = undefined;
      delete prompt.dataset.nestNews;
      return;
    }
    if (previousPlaceholder === undefined) previousPlaceholder = prompt.placeholder;
    const media = !!scene.querySelector('.ws-media-panel:not([hidden])');
    if (media !== mediaOpen) {
      mediaOpen = media;
      mediaQuiet = media && mode === 'preview' && !preview.expanded;
      if (!media && mode === 'preview') unread = false;
      updateControls();
    }
    const news = Boolean(reading());
    prompt.toggleAttribute('data-nest-news', news);
    prompt.placeholder = news ? '追问这条新闻…' : '和未央说说话…';
  }
  const sceneObserver = new MutationObserver(sync);
  function attach(view) {
    scene = view.querySelector('.ws-scene');
    caption = view.querySelector('.ws-caption');
    roomMenu = scene.querySelector('.ws-room-menu');
    roomMenuButton = scene.querySelector('[data-room-action="menu"]');
    roomMenu.append(historyButton);
    viewControls = [view.querySelector('.ws-floor-toggle'), view.querySelector('.ws-zoom-toggle')];
    view.querySelector('.ws-header').append(toggle);
    sceneObserver.observe(scene, { attributes: true, attributeFilter: ['data-room-view', 'data-nest-layout'] });
    sceneObserver.observe(roomMenu, { attributes: true, attributeFilter: ['hidden'] });
    // 只监听设备开关和新闻项目是否可读，避开场景动画、正文流式和逐帧样式变更。
    for (const node of scene.querySelectorAll('.ws-media-panel, .ws-media-news, .ws-media-actions')) {
      sceneObserver.observe(node, { attributes: true, attributeFilter: ['hidden', 'data-device'] });
    }
    sync();
  }
  function expand() {
    setMode('history');
    if (readingPosition) readingPosition(); else transcript.scrollTop = transcript.scrollHeight;
    collapse.focus({ preventScroll: true });
  }
  toggle.onclick = () => setMode(mode === 'hidden' || mediaQuiet ? 'preview' : 'hidden');
  collapse.onclick = () => { setMode('preview'); toggle.focus({ preventScroll: true }); };
  chat.addEventListener('focusin', () => {
    if (mode === 'hidden' && sheet.hasAttribute('data-nest-immersive')) setMode('preview');
  });
  sheet.addEventListener('click', event => {
    if (!sheet.hasAttribute('data-nest-immersive')) return;
    if (event.target.closest('.ws-media-primary') && (mediaQuiet || mode === 'hidden')) setMode('preview');
    if (mode !== 'preview') return;
    if (event.target.closest('.ws-floorplan') && !event.target.closest('button,a,input,[role="button"]')) setMode('hidden');
  }, true);
  sheet.addEventListener('click', event => {
    if (event.target.closest('.ws-room-menu .ws-zoom-toggle') && !roomMenu.hidden) roomMenuButton.click();
  });
  // 读屏和键盘用户也可以打开全文，不需要把静态消息冒充按钮。
  const historyButton = document.createElement('button');
  historyButton.type = 'button';
  historyButton.className = 'nest-chat-history';
  historyButton.textContent = '查看聊天记录';
  historyButton.onclick = () => { if (!roomMenu.hidden) roomMenuButton.click(); expand(); };
  function close() {
    sceneObserver.disconnect();
    menuSize.disconnect();
    const floating = sheet.hasAttribute('data-nest-immersive');
    if (floating && mode === 'history') rememberPosition();
    const restoreReading = floating ? readingPosition : null;
    preview.stop();
    mediaOpen = false;
    setMode('preview');
    if (previousPlaceholder !== undefined) prompt.placeholder = previousPlaceholder;
    previousPlaceholder = undefined;
    delete prompt.dataset.nestNews;
    sheet.removeAttribute('data-nest-immersive');
    readingPosition = null;
    return restoreReading;
  }
  setMode('preview');
  return { attach, close, back() {
    if (!sheet.hasAttribute('data-nest-immersive')) return false;
    if (preview.collapse()) return true;
    if (mode !== 'history') return false;
    collapse.click();
    return true;
  } };
}
