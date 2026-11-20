export function mediaNode(tag, className, value = '') {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = value;
  return el;
}

function button(label, className = '') {
  const el = mediaNode('button', className, label);
  el.type = 'button';
  return el;
}

function link(label) {
  const el = mediaNode('a', 'ws-media-link', label);
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  return el;
}

export function renderWorkshopChannelButtons(container, channels) {
  container.replaceChildren(...channels.map(channel => {
    const ch = button('');
    ch.dataset.channel = channel.id;
    ch.setAttribute('aria-label', channel.label);
    if (channel.kind === 'cctv') {
      ch.append(mediaNode('span', 'ws-channel-prefix', 'CCTV-'), channel.number + ' ' + channel.title);
    } else {
      ch.textContent = channel.title;
    }
    return ch;
  }));
}

export function mediaControls(scene, floor, channels, player) {
  function device(id, label) {
    const el = button(label, 'ws-device');
    el.dataset.mediaDevice = id;
    el.title = label;
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-expanded', 'false');
    floor.append(el);
    return el;
  }
  const monitor = device('monitor', '打开工作显示器');
  const mini = mediaNode('span', 'ws-mini-screen');
  mini.setAttribute('aria-hidden', 'true');
  monitor.replaceChildren(mini);
  const tv = device('tv', '打开电视');
  tv.replaceChildren();
  const ticker = button('', 'ws-monitor-ticker');
  const tickerLabel = mediaNode('small', '', '桌面新闻');
  const tickerText = mediaNode('span', '');
  ticker.append(tickerLabel, tickerText);
  const panel = mediaNode('section', 'ws-media-panel');
  panel.hidden = true;
  const header = mediaNode('div', 'ws-media-header');
  const heading = mediaNode('h3', '');
  const back = button('返回房间', 'ws-media-back');
  const switchScreen = button('切到新闻');
  header.append(heading, switchScreen, back);
  const scroll = mediaNode('div', 'ws-media-scroll');
  const news = mediaNode('div', 'ws-media-news');
  const title = mediaNode('h4', 'ws-media-title');
  const credit = mediaNode('p', 'ws-media-credit');
  const latest = mediaNode('small', 'ws-media-updated');
  const original = link('阅读原文');
  const ask = button('问未央', 'ws-media-primary');
  const brief = button('生成简报');
  const actions = mediaNode('div', 'ws-media-actions');
  actions.append(ask, brief, original);
  const prev = button('上一条');
  const next = button('下一条');
  const refresh = button('刷新新闻');
  const nav = mediaNode('div', 'ws-media-nav');
  nav.append(prev, next, refresh);
  const newsTools = mediaNode('div', 'ws-news-tools');
  newsTools.append(actions, nav);
  news.append(title, credit, latest);
  const television = mediaNode('div', 'ws-media-tv');
  const receiver = mediaNode('div', 'ws-media-receiver');
  const glass = mediaNode('div', 'ws-tv-glass ws-media-screen');
  glass.append(player.element, player.standby);
  const grille = mediaNode('span', 'ws-tv-grille');
  grille.setAttribute('aria-hidden', 'true');
  receiver.append(glass, grille);
  const channelButtons = mediaNode('div', 'ws-media-channels');
  channelButtons.setAttribute('role', 'group');
  channelButtons.setAttribute('aria-label', '电视频道');
  renderWorkshopChannelButtons(channelButtons, channels);
  const network = link('央视网');
  network.setAttribute('aria-label', '去央视网观看');
  const power = button('关机');
  power.setAttribute('aria-label', '关闭电视');
  const manageSources = button('视频源', 'ws-source-switch');
  manageSources.setAttribute('aria-label', '管理视频源');
  manageSources.setAttribute('aria-expanded', 'false');
  const stations = mediaNode('div', 'ws-tv-stations');
  stations.append(channelButtons, network, power);
  const remote = mediaNode('div', 'ws-media-remote ws-tv-controls');
  remote.append(manageSources, stations);
  television.append(receiver, remote);
  const task = mediaNode('div', 'ws-media-work');
  const taskTitle = mediaNode('h4', 'ws-media-title');
  const taskDetail = mediaNode('p', 'ws-media-credit');
  task.append(taskTitle, taskDetail);
  scroll.append(news, television, task);
  panel.append(header, scroll, newsTools);
  scene.append(ticker);
  return { monitor, mini, tv, ticker, tickerLabel, tickerText, panel, heading, back, switchScreen,
    news, newsTools, title, credit, latest, original, actions, ask, brief, prev, next, refresh,
    television, channelButtons, manageSources, network, power, task, taskTitle, taskDetail, scroll };
}
