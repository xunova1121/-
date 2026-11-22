import { listWorkshopChannels, workshopChannel, workshopChannelScope, selectWorkshopChannel,
  onWorkshopChannel, onWorkshopChannelListChanged } from './workshopMediaChannels.js';
import { mediaControls, renderWorkshopChannelButtons } from './workshopMediaView.js';
import { createWorkshopTvPlayer } from './workshopTvPlayer.js';
import { createWorkshopNewsReader } from './workshopNewsReader.js';
import { createWorkshopSourceManager } from './workshopSourceManager.js';
import './workshopMedia.css';
import './nestMedia.css';

const REFRESH = 15 * 60_000;
const localTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function clock(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? localTime.format(date) : '';
}

// 只缩放节目/新闻这一层；动画起止坐标与实际可见设备一致。
export function animateWorkshopPanel(panel, screen, opening) {
  if (!screen?.width || !screen.height || !panel.animate ||
      document.documentElement.classList.contains('safe-render') ||
      document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const page = panel.getBoundingClientRect();
  if (!page.width || !page.height) return null;
  const dx = screen.left - page.left, dy = screen.top - page.top;
  const small = { transform: `translate(${dx}px,${dy}px) scale(${screen.width / page.width},${screen.height / page.height})`, opacity: .65 };
  const full = { transform: 'none', opacity: 1 };
  return panel.animate(opening ? [small, full] : [full, small], {
    duration: opening ? 350 : 160, easing: opening ? 'cubic-bezier(.22,.67,.25,1)' : 'ease-in'
  });
}

export function createWorkshopMedia({ scene, floor, room, newsFeed, newsChat, getPlayers }) {
  const player = createWorkshopTvPlayer({ getPlayers, openSources: () => ui.manageSources.click() });
  const ui = mediaControls(scene, floor, listWorkshopChannels(), player);
  const reader = createWorkshopNewsReader(ui, newsFeed, row => {
    article = row;
    draw();
  });
  let device = '';
  let motion;
  let folding = false;
  let monitorTrigger;
  let sessionId = '';
  let busy = false;
  let taskTitle = '';
  let taskDetail = '';
  let readDuringWork = false;
  let visible = false;
  let feed = null;
  let article = null;
  let bound = null;
  let request = null;
  let loadTimer, rotateTimer, unsubscribe, unsubscribeList;
  let channel = workshopChannel();
  let scope = workshopChannelScope();
  const readerContext = () => JSON.stringify([scope, sessionId]);
  const workOnMonitor = () => busy && !readDuringWork;
  const sources = createWorkshopSourceManager(ui, {
    preview: candidate => player.preview(candidate),
    restoreChannel: () => player.select(channel?.id),
    selectChannel: selectWorkshopChannel,
    updateChannelState
  });

  function updateChannelState() {
    const testing = sources.testing();
    const station = testing ? '试播中' : channel?.label || '';
    if (ui.stationName.textContent !== station) ui.stationName.textContent = station;
    ui.network.hidden = testing || !channel?.url;
    if (channel?.url) ui.network.href = channel.url;
    else ui.network.removeAttribute('href');
    ui.network.textContent = channel?.kind === 'cctv' ? '央视网' : '频道官网';
    ui.network.setAttribute('aria-label', channel?.kind === 'cctv' ? '去央视网观看' : '打开频道官网');
    for (const el of ui.channelButtons.children) {
      el.setAttribute('aria-pressed', String(!testing && el.dataset.channel === channel?.id));
    }
  }
  function refreshChannels() {
    renderWorkshopChannelButtons(ui.channelButtons, listWorkshopChannels());
    sources.refresh();
    updateChannelState();
  }
  function catalogChanged() {
    if (scope !== workshopChannelScope()) { syncChannelScope(); syncTimers(); draw(); return; }
    channel = workshopChannel();
    refreshChannels();
    if (visible && device === 'tv' && !sources.testing()) player.select(channel?.id);
  }
  function syncChannelScope() {
    const next = workshopChannelScope();
    if (scope === next) return false;
    scope = next;
    bind(null);
    article = reader.lastArticle(readerContext()) || feed?.items[0] || null;
    sources.reset();
    player.close();
    channel = workshopChannel();
    refreshChannels();
    if (visible && device === 'tv') player.select(channel?.id);
    return true;
  }

  function bind(item) {
    if (bound === item) return;
    bound = item;
    if (item) newsChat?.select(sessionId, item);
    else newsChat?.clear();
  }
  function draw() {
    const reading = device === 'monitor' && !workOnMonitor();
    reader.select(visible && reading ? article : null, feed?.items, readerContext());
    ui.panel.hidden = !device;
    scene.dataset.mediaDevice = device;
    scene.dataset.mediaWork = String(busy);
    const studio = scene.closest('.work-studio-view');
    if (studio) {
      studio.toggleAttribute('data-media-open', Boolean(device));
      studio.toggleAttribute('data-wide-workshop', scene.dataset.roomView === 'nest' || device === 'tv');
      if (device && scene.dataset.roomView === 'floor') studio.dataset.floorMedia = device;
      else delete studio.dataset.floorMedia;
    }
    ui.panel.dataset.device = device;
    ui.panel.setAttribute('aria-label', device === 'tv' ? '电视' : reading ? '新闻简报' : '工作显示器');
    ui.monitor.setAttribute('aria-expanded', String(device === 'monitor'));
    ui.tv.setAttribute('aria-expanded', String(device === 'tv'));
    ui.heading.textContent = device === 'tv' ? '电视频道' : reading ? '新闻简报' : '工作进度';
    ui.switchScreen.hidden = !busy || device !== 'monitor';
    ui.switchScreen.textContent = reading ? '查看进度' : '切到新闻';
    ui.news.hidden = !reading;
    ui.newsTools.hidden = !reading;
    ui.television.hidden = device !== 'tv';
    ui.task.hidden = device !== 'monitor' || !workOnMonitor();
    ui.taskTitle.textContent = taskTitle;
    ui.taskDetail.textContent = taskDetail;
    const headline = article?.title || (request ? '正在读取新闻…' : '暂未收到新闻');
    ui.mini.textContent = busy ? taskTitle : headline;
    ui.ticker.hidden = !!device;
    ui.tickerLabel.textContent = busy ? '工位' : '新闻简报';
    ui.tickerText.textContent = busy ? taskTitle : headline;
    ui.title.textContent = headline;
    ui.credit.textContent = article ? [article.source, clock(article.publishedAt)].filter(Boolean).join(' · ') : '';
    ui.latest.textContent = feed?.updatedAt
      ? (feed.stale ? '暂未刷新 · 上次更新 ' : '上次更新 ') + clock(feed.updatedAt) : '';
    ui.actions.hidden = !article;
    ui.prev.disabled = ui.next.disabled = !(feed?.items?.length > 1);
    ui.refresh.disabled = !!request;
    updateChannelState();
    bind(visible && sessionId && (reading || !device && !busy) ? article : null);
  }

  function setArticle(offset) {
    const items = feed?.items || [];
    if (items.length < 2) return;
    const pos = items.findIndex(item => item.url === article?.url);
    article = items[(Math.max(0, pos) + offset + items.length) % items.length];
    draw();
  }
  function syncFeed(nextFeed) {
    if (!nextFeed) return;
    feed = nextFeed;
    const match = feed.items.find(item => item.url === article?.url);
    // 翻阅或起草问题期间，即使新的栏目列表淘汰了旧条目，也保留眼前这一篇。
    article = match || ((device === 'monitor' || drafting()) ? article : null) || feed.items[0] || null;
  }
  function drafting() {
    const input = document.getElementById('prompt');
    return input && (document.activeElement === input || input.value?.trim());
  }
  function stopFeed() {
    clearTimeout(loadTimer);
    clearInterval(rotateTimer);
    if (request) {
      const pending = request;
      request = null;
      pending.abort();
    }
  }
  function wantsFeed() {
    return visible && (!busy || device === 'monitor' && readDuringWork);
  }
  async function load(force = false) {
    if (request || !newsFeed || !wantsFeed()) return;
    clearTimeout(loadTimer);
    const pending = new AbortController();
    request = pending;
    draw();
    try {
      const result = await newsFeed.load({ force, signal: pending.signal });
      if (request === pending) syncFeed(result);
    } catch {
      if (request === pending && feed) feed = { ...feed, stale: true };
    } finally {
      if (request === pending) {
        request = null;
        draw();
        if (wantsFeed()) loadTimer = setTimeout(load, REFRESH);
      }
    }
  }
  function syncTimers() {
    stopFeed();
    if (!wantsFeed()) return;
    syncFeed(newsFeed?.peek());
    void load();
    rotateTimer = setInterval(() => {
      if (!busy && !device && !drafting() && !ui.ticker.matches(':hover,:focus-visible') &&
          !document.body.classList.contains('reduced-motion') && !matchMedia('(prefers-reduced-motion: reduce)').matches) setArticle(1);
    }, 18_000);
  }
  function selectChannel(next, change) {
    if (!visible || change?.catalogChanged) return;
    sources.reset();
    channel = next;
    if (device !== 'tv') { show('tv'); return; }
    room.perform('tv');
    player.select(channel.id);
    draw();
  }
  function mediaOrigin(which, trigger) {
    // 近看工位时，设备可能在画外；简报仍可从实际点到的入口展开。
    const screen = (which === 'monitor' ? ui.mini : ui.tv).getBoundingClientRect();
    const view = scene.getBoundingClientRect();
    const left = Math.max(screen.left, view.left), top = Math.max(screen.top, view.top);
    const width = Math.min(screen.right, view.right) - left, height = Math.min(screen.bottom, view.bottom) - top;
    return width > 0 && height > 0 ? { left, top, width, height } : trigger.getBoundingClientRect();
  }
  function cancelMotion() {
    if (motion) { motion.onfinish = null; motion.cancel(); motion = null; }
    folding = false;
  }
  function setTuner(open) {
    ui.tune.setAttribute('aria-expanded', String(open));
    ui.stations.hidden = !ui.tune.hidden && !open;
  }
  function show(next, perform = true, trigger = next === 'tv' ? ui.tv : ui.monitor) {
    cancelMotion();
    const screen = (next === 'monitor' || scene.dataset.roomView === 'nest') && device !== next
      ? mediaOrigin(next, trigger) : null;
    scene.dispatchEvent(new CustomEvent('workshop:media-opening', { detail: { device: next } }));
    setTuner(false);
    syncChannelScope();
    sources.reset();
    device = next;
    if (next === 'tv') {
      if (perform) room.perform('tv');
      player.select(channel?.id);
    } else {
      monitorTrigger = trigger;
      if (trigger !== ui.ticker) {
        const last = reader.lastArticle(readerContext());
        if (last) article = feed?.items.find(item => item.url === last.url) || last;
      }
      player.close();
      if (perform && !busy) room.perform('news');
    }
    draw();
    motion = animateWorkshopPanel(ui.panel, screen, true);
    if (next === 'tv' || workOnMonitor()) ui.scroll.scrollTop = 0;
    ui.back.focus({ preventScroll: true });
  }
  function close(restoreFocus = true) {
    if (!device) return false;
    const trigger = device === 'tv' ? ui.tv : monitorTrigger;
    if (restoreFocus && folding) return true;
    cancelMotion();
    if (restoreFocus && visible && scene.dataset.roomView === 'nest') {
      motion = animateWorkshopPanel(ui.panel, mediaOrigin(device, trigger), false);
      if (motion) {
        folding = true;
        motion.onfinish = () => finishClose(trigger, true);
        return true;
      }
    }
    finishClose(trigger, restoreFocus);
    return true;
  }
  function finishClose(trigger, restoreFocus) {
    cancelMotion();
    setTuner(false);
    const wasReadingDuringWork = readDuringWork;
    readDuringWork = false;
    device = '';
    sources.reset();
    player.close();
    if (wasReadingDuringWork) syncTimers();
    draw();
    if (restoreFocus) {
      const target = trigger.closest('.ws-room-menu[hidden]') ? scene.querySelector('[data-room-action="menu"]') : trigger;
      target?.focus({ preventScroll: true });
    }
  }
  ui.tune.onclick = () => {
    const open = ui.stations.hidden;
    if (!sources.testing()) sources.escape();
    setTuner(open);
    if (open) ui.channelButtons.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  };
  ui.manageSources.addEventListener('click', () => setTuner(false));
  ui.tv.onclick = () => show('tv');
  ui.monitor.onclick = ui.ticker.onclick = event => show('monitor', true, event.currentTarget);
  ui.back.onclick = () => close();
  ui.power.onclick = () => { room.perform('tv-off'); close(); };
  ui.channelButtons.onclick = event => {
    const id = event.target.closest('button')?.dataset.channel;
    if (id) {
      selectWorkshopChannel(id);
      if (!ui.tune.hidden) { setTuner(false); ui.tune.focus({ preventScroll: true }); }
    }
  };
  scene.addEventListener('workshop:open-tv', () => show('tv', false));
  scene.addEventListener('workshop:close-media', () => close(false));
  ui.switchScreen.onclick = () => { readDuringWork = !readDuringWork; syncTimers(); draw(); };
  ui.prev.onclick = () => setArticle(-1);
  ui.next.onclick = () => setArticle(1);
  ui.refresh.onclick = () => load(true);
  ui.ask.onclick = () => article && newsChat?.ask(sessionId, article);
  ui.brief.onclick = () => article && newsChat?.brief(sessionId, article);
  ui.panel.onkeydown = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (sources.escape()) return;
      if (!ui.tune.hidden && !ui.stations.hidden) {
        setTuner(false);
        ui.tune.focus({ preventScroll: true });
      } else close();
    }
  };

  return {
    panel: ui.panel,
    setNest(on) {
      // 在小窝可点实物电脑；新闻标题只在主动打开互动菜单后显示。
      const host = on ? scene.querySelector('.ws-room-menu') : scene;
      host.append(ui.ticker);
      scene.closest('.work-studio-view')?.toggleAttribute('data-wide-workshop', on || device === 'tv');
      ui.watcher.hidden = on;
      ui.tune.hidden = ui.stationName.hidden = !on;
      if (on) ui.stations.prepend(ui.manageSources);
      else ui.remote.insertBefore(ui.manageSources, ui.stations);
      setTuner(false);
      for (const target of [ui.monitor, ui.tv]) {
        if (on) target.removeAttribute('title');
        else target.title = target.getAttribute('aria-label');
      }
    },
    setVisible(on) {
      if (visible === on) return;
      visible = on;
      if (on) {
        syncChannelScope();
        channel = workshopChannel();
        refreshChannels();
        unsubscribe = onWorkshopChannel(selectChannel);
        unsubscribeList = onWorkshopChannelListChanged(catalogChanged);
        if (device === 'tv') player.select(channel?.id);
      } else {
        if (folding) close(false);
        else cancelMotion();
        unsubscribe?.();
        unsubscribeList?.();
        sources.suspend();
        player.close();
      }
      syncTimers();
      draw();
    },
    setTask(id, working, title, detail) {
      const scopeChanged = syncChannelScope();
      const sessionChanged = id !== sessionId;
      if (sessionChanged) {
        close(false);
        sessionId = id;
        article = reader.lastArticle(readerContext()) || feed?.items[0] || null;
        bind(null);
      }
      const changed = busy !== working;
      if (!sessionChanged && !scopeChanged && !changed && taskTitle === title && taskDetail === detail) return;
      busy = working;
      taskTitle = title;
      taskDetail = detail;
      if (changed || scopeChanged) { readDuringWork = false; syncTimers(); }
      draw();
    },
    powerOff() { if (device === 'tv') close(false); },
    close
  };
}
