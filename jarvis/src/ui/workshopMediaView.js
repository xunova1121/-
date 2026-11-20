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
  news.append(title, credit, actions, latest, nav);
  const television = mediaNode('div', 'ws-media-tv');
  const channelButtons = mediaNode('div', 'ws-media-channels');
  channelButtons.setAttribute('role', 'group');
  channelButtons.setAttribute('aria-label', '央视频道');
  for (const channel of channels) {
    const ch = button(channel.label);
    ch.dataset.channel = channel.id;
    channelButtons.append(ch);
  }
  const network = link('去央视网观看');
  const power = button('关闭电视');
  const remote = mediaNode('div', 'ws-media-actions');
  remote.append(network, power);
  television.append(player.element, channelButtons, remote);
  const task = mediaNode('div', 'ws-media-work');
  const taskTitle = mediaNode('h4', 'ws-media-title');
  const taskDetail = mediaNode('p', 'ws-media-credit');
  task.append(taskTitle, taskDetail);
  scroll.append(news, television, task);
  panel.append(header, scroll);
  scene.append(ticker, panel);
  return { monitor, mini, tv, ticker, tickerLabel, tickerText, panel, heading, back, switchScreen,
    news, title, credit, latest, original, actions, ask, brief, prev, next, refresh,
    television, channelButtons, network, power, task, taskTitle, taskDetail, scroll };
}
