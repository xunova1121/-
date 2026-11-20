import { listWorkshopChannels, workshopChannel, workshopChannelScope, selectWorkshopChannel,
  onWorkshopChannel, onWorkshopChannelListChanged } from './workshopMediaChannels.js';
import { mediaControls, renderWorkshopChannelButtons } from './workshopMediaView.js';
import { createWorkshopTvPlayer } from './workshopTvPlayer.js';
import { createWorkshopNewsReader } from './workshopNewsReader.js';
import { createWorkshopSourceManager } from './workshopSourceManager.js';
import './workshopMedia.css';

const REFRESH = 15 * 60_000;
const localTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function clock(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? localTime.format(date) : '';
}

export function createWorkshopMedia({ scene, floor, room, newsFeed, newsChat, getPlayers }) {
  const player = createWorkshopTvPlayer({ getPlayers });
  const ui = mediaControls(scene, floor, listWorkshopChannels(), player);
  const selectNewsArticle = createWorkshopNewsReader(ui, newsFeed);
  let device = '';
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
  const workOnMonitor = () => busy && !readDuringWork;
  const sources = createWorkshopSourceManager(ui, {
    preview: candidate => player.preview(candidate),
    restoreChannel: () => player.select(channel.id),
    selectChannel: selectWorkshopChannel,
    updateChannelState
  });

  function updateChannelState() {
    const testing = sources.testing();
    ui.network.hidden = testing || !channel.url;
    if (channel.url) ui.network.href = channel.url;
    else ui.network.removeAttribute('href');
    ui.network.textContent = channel.kind === 'cctv' ? '央视网' : '频道官网';
    ui.network.setAttribute('aria-label', channel.kind === 'cctv' ? '去央视网观看' : '打开频道官网');
    for (const el of ui.channelButtons.children) {
      el.setAttribute('aria-pressed', String(!testing && el.dataset.channel === channel.id));
    }
  }
  function refreshChannels() {
    renderWorkshopChannelButtons(ui.channelButtons, listWorkshopChannels());
    sources.refresh();
    updateChannelState();
  }
  function catalogChanged() {
    if (scope !== workshopChannelScope()) { syncChannelScope(); return; }
    channel = workshopChannel();
    refreshChannels();
    if (visible && device === 'tv' && !sources.testing()) player.select(channel.id);
  }
  function syncChannelScope() {
    const next = workshopChannelScope();
    if (scope === next) return;
    scope = next;
    sources.reset();
    player.close();
    channel = workshopChannel();
    refreshChannels();
    if (visible && device === 'tv') player.select(channel.id);
  }

  function bind(item) {
    if (bound === item) return;
    bound = item;
    if (item) newsChat?.select(sessionId, item);
    else newsChat?.clear();
  }
  function draw() {
    const reading = device === 'monitor' && !workOnMonitor();
    ui.panel.hidden = !device;
    scene.closest('.work-studio-view')?.toggleAttribute('data-media-open', Boolean(device));
    ui.panel.dataset.device = device;
    ui.panel.setAttribute('aria-label', device === 'tv' ? '电视' : '工作显示器');
    ui.monitor.setAttribute('aria-expanded', String(device === 'monitor'));
    ui.tv.setAttribute('aria-expanded', String(device === 'tv'));
    ui.heading.textContent = device === 'tv' ? '电视频道' : reading ? '桌面新闻' : '工作进度';
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
    ui.tickerLabel.textContent = busy ? '工位' : '桌面新闻';
    ui.tickerText.textContent = busy ? taskTitle : headline;
    ui.title.textContent = headline;
    ui.credit.textContent = article ? [article.source, clock(article.publishedAt)].filter(Boolean).join(' · ') : '';
    ui.latest.textContent = feed?.updatedAt
      ? (feed.stale ? '暂未刷新 · 上次更新 ' : '上次更新 ') + clock(feed.updatedAt) : '';
    ui.actions.hidden = !article;
    selectNewsArticle(visible && reading ? article : null);
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
  function selectChannel(next) {
    if (!visible) return;
    sources.reset();
    channel = next;
    if (device !== 'tv') { show('tv'); return; }
    room.perform('tv');
    player.select(channel.id);
    draw();
  }
  function show(next, perform = true) {
    syncChannelScope();
    sources.reset();
    device = next;
    if (next === 'tv') {
      if (perform) room.perform('tv');
      player.select(channel.id);
    } else {
      player.close();
      if (perform && !busy) room.perform('news');
    }
    draw();
    ui.scroll.scrollTop = 0;
    ui.back.focus({ preventScroll: true });
  }
  function close(restoreFocus = true) {
    if (!device) return false;
    const trigger = device === 'tv' ? ui.tv : ui.monitor;
    const wasReadingDuringWork = readDuringWork;
    readDuringWork = false;
    device = '';
    sources.reset();
    player.close();
    if (wasReadingDuringWork) syncTimers();
    draw();
    if (restoreFocus) trigger.focus({ preventScroll: true });
    return true;
  }
  ui.tv.onclick = () => show('tv');
  ui.monitor.onclick = ui.ticker.onclick = () => show('monitor');
  ui.back.onclick = () => close();
  ui.power.onclick = () => { room.perform('tv-off'); close(); };
  ui.channelButtons.onclick = event => {
    const id = event.target.closest('button')?.dataset.channel;
    if (id) selectWorkshopChannel(id);
  };
  scene.addEventListener('workshop:open-tv', () => show('tv', false));
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
      if (!sources.escape()) close();
    }
  };

  return {
    panel: ui.panel,
    setVisible(on) {
      if (visible === on) return;
      visible = on;
      if (on) {
        syncChannelScope();
        channel = workshopChannel();
        refreshChannels();
        unsubscribe = onWorkshopChannel(selectChannel);
        unsubscribeList = onWorkshopChannelListChanged(catalogChanged);
        if (device === 'tv') player.select(channel.id);
      } else {
        unsubscribe?.();
        unsubscribeList?.();
        sources.suspend();
        player.close();
      }
      syncTimers();
      draw();
    },
    setTask(id, working, title, detail) {
      syncChannelScope();
      const sessionChanged = id !== sessionId;
      if (sessionChanged) {
        sessionId = id;
        bind(null);
        close(false);
      }
      const changed = busy !== working;
      if (!sessionChanged && !changed && taskTitle === title && taskDetail === detail) return;
      busy = working;
      taskTitle = title;
      taskDetail = detail;
      if (changed) { readDuringWork = false; syncTimers(); }
      draw();
    },
    powerOff() { if (device === 'tv') close(false); },
    close
  };
}
