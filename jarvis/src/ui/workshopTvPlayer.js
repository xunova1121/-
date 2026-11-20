import { WORKSHOP_TV_CHANNELS, workshopTvPlayers } from '../../shared/workshopTv.js';
import meadowMp4 from './assets/workStudio/meadow-preview.mp4';
import meadowWebm from './assets/workStudio/meadow-preview.webm';
import filmCredit from '../../licenses/workshop-film.txt?raw';
import './workshopTvPlayer.css';

function playerPart(tag, className, copy = '') {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = copy;
  return el;
}

function inlineVideo(label) {
  const video = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('aria-label', label);
  return video;
}

// 频道和本地短片共用一块玻璃屏，始终只保留一份解码资源。
export function createWorkshopTvPlayer({ getPlayers } = {}) {
  const element = playerPart('div', 'ws-tv-player');
  const standby = playerPart('div', 'ws-tv-standby');
  element.hidden = standby.hidden = true;
  let request, current, viewer;

  function clearScreen() {
    if (viewer) {
      viewer.onerror = null;
      if (viewer === element.querySelector('video') || viewer === standby.querySelector('video')) {
        viewer.pause();
        viewer.removeAttribute('src');
        viewer.load();
      }
      viewer = null;
    }
    element.replaceChildren();
    standby.replaceChildren();
    element.hidden = standby.hidden = true;
  }

  function close() {
    request?.abort();
    request = null;
    current = null;
    clearScreen();
  }

  function signalCard(title, detail, buttons = []) {
    const caption = playerPart('div', 'ws-tv-caption');
    const description = playerPart('span', 'ws-tv-detail', detail);
    description.setAttribute('role', 'status');
    caption.replaceChildren(playerPart('strong', 'ws-tv-station', title), description, ...buttons);
    return caption;
  }

  function action(label, onClick) {
    const button = playerPart('button', 'ws-tv-action', label);
    button.type = 'button';
    button.onclick = onClick;
    return button;
  }

  function problem(channel, detail, offerClip) {
    clearScreen();
    const retry = action('重新连接', () => select(channel.id, true));
    const buttons = [retry];
    if (offerClip) buttons.push(action('看未央风景短片', () => playClip(channel, '直播暂不可用')));
    standby.replaceChildren(signalCard(channel.name, detail, buttons));
    standby.hidden = false;
  }

  function playClip(channel, reason) {
    clearScreen();
    const title = '未央风景短片 · 非频道直播';
    const clip = inlineVideo(title);
    clip.loop = true;
    clip.title = filmCredit.trim();
    clip.setAttribute('aria-description', clip.title);
    // 有些内置 Chromium 只含 VP8 解码器；先按设备能力选片，如果播放出错只换一次编码。
    const supportsAvc = clip.canPlayType('video/mp4; codecs="avc1.42E01F"');
    const webmFirst = !supportsAvc && clip.canPlayType('video/webm; codecs="vp8"');
    let alternate = webmFirst ? meadowMp4 : meadowWebm;
    clip.onerror = () => {
      if (viewer !== clip) return;
      if (alternate) {
        clip.src = alternate;
        alternate = null;
      } else {
        problem(channel, '本机未能播放风景短片', false);
      }
    };
    viewer = clip;
    clip.src = webmFirst ? meadowWebm : meadowMp4;
    standby.replaceChildren(clip, signalCard(title, channel.name + ' ' + reason));
    standby.hidden = false;
  }

  async function select(channelId, retry = false) {
    if (!retry && current === channelId) return;
    close();
    const channel = WORKSHOP_TV_CHANNELS.find(ch => ch.id === channelId);
    if (!channel) return;
    current = channelId;
    const loading = new AbortController();
    request = loading;
    standby.replaceChildren(signalCard(channel.name, '正在连接频道…'));
    standby.hidden = false;
    let configured;
    try { configured = await getPlayers?.(loading.signal); } catch {
      if (!loading.signal.aborted) problem(channel, '暂时无法读取频道配置', true);
      return;
    }
    if (loading.signal.aborted) return;
    const source = workshopTvPlayers(configured)[channelId];
    if (!source) {
      playClip(channel, '直播未接入');
      return;
    }
    clearScreen();
    if (source.type === 'media') {
      viewer = inlineVideo(channel.name);
    } else {
      viewer = document.createElement('iframe');
      viewer.title = channel.name + '授权播放器';
      viewer.setAttribute('sandbox', 'allow-scripts allow-presentation');
      viewer.allow = 'autoplay; fullscreen';
      viewer.allowFullscreen = true;
      viewer.referrerPolicy = 'strict-origin-when-cross-origin';
    }
    viewer.onerror = () => {
      if (!loading.signal.aborted) problem(channel, '此设备暂时无法播放该频道', true);
    };
    viewer.src = source.url;
    element.replaceChildren(viewer);
    element.hidden = false;
  }

  return { element, standby, select, close };
}
