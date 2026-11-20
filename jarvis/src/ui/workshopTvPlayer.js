import { workshopTvPlayers } from '../../shared/workshopTv.js';
import { listWorkshopChannels } from './workshopMediaChannels.js';
import { parseWorkshopVideoSource } from '../../shared/workshopVideoSource.js';
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
export function createWorkshopTvPlayer({ getPlayers, loadHls = () => import('hls.js') } = {}) {
  const element = playerPart('div', 'ws-tv-player');
  const standby = playerPart('div', 'ws-tv-standby');
  element.hidden = standby.hidden = true;
  let request, current, viewer, hls;

  function clearScreen() {
    if (viewer) {
      viewer.onerror = null;
      hls?.destroy();
      hls = null;
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
    const retry = action('重新连接', () => tune(channel, true));
    const buttons = [retry];
    if (offerClip) buttons.push(action('看未央风景短片', () => playClip(channel, '直播暂不可用')));
    standby.replaceChildren(signalCard(channel.label, detail, buttons));
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
    standby.replaceChildren(clip, signalCard(title, channel.label + ' ' + reason));
    standby.hidden = false;
  }

  async function attachHls(video, url, channel, signal) {
    const active = () => !signal.aborted && viewer === video;
    try {
      const { default: Hls } = await loadHls();
      if (!active()) return;
      if (!Hls.isSupported()) {
        problem(channel, '当前播放器无法解码这个直播源', true);
        return;
      }
      const session = new Hls();
      hls = session;
      session.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !active()) return;
        const detail = data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? '未能读取直播，请检查地址、网络或视频源的跨域设置'
          : '此设备无法播放该直播格式';
        problem(channel, detail, true);
      });
      session.loadSource(url);
      session.attachMedia(video);
    } catch {
      if (active()) problem(channel, '直播播放器加载失败，请重新连接', true);
    }
  }

  async function tune(channel, retry = false) {
    const key = channel.id + '|' + (channel.source?.url || '') + '|' + (channel.source?.format || '');
    if (!retry && current === key) {
      if (viewer && !element.hidden) viewer.setAttribute('aria-label', channel.label);
      return;
    }
    close();
    current = key;
    const loading = new AbortController();
    request = loading;
    standby.replaceChildren(signalCard(channel.label, '正在连接频道…'));
    standby.hidden = false;
    let source = channel.source;
    if (channel.kind === 'cctv') {
      try { source = workshopTvPlayers(await getPlayers?.(loading.signal))[channel.id]; } catch {
        if (!loading.signal.aborted) problem(channel, '暂时无法读取频道配置', true);
        return;
      }
    }
    if (loading.signal.aborted) return;
    if (!source) {
      playClip(channel, '直播未接入');
      return;
    }
    clearScreen();
    if (source.type === 'media') {
      viewer = inlineVideo(channel.label);
    } else {
      viewer = document.createElement('iframe');
      viewer.title = channel.label + '授权播放器';
      viewer.setAttribute('sandbox', 'allow-scripts allow-presentation');
      viewer.allow = 'autoplay; fullscreen';
      viewer.allowFullscreen = true;
      viewer.referrerPolicy = 'strict-origin-when-cross-origin';
    }
    const media = viewer;
    const failed = () => {
      if (!loading.signal.aborted && media === viewer) problem(channel, '此设备暂时无法播放该频道', true);
    };
    media.onerror = failed;
    element.replaceChildren(media);
    element.hidden = false;
    const isHls = source.type === 'media' && (source.format === 'hls' || /\.m3u8$/i.test(new URL(source.url).pathname));
    if (isHls) {
      if (!media.canPlayType('application/vnd.apple.mpegurl')) {
        await attachHls(media, source.url, channel, loading.signal);
        return;
      }
      // 部分 WebView 声明支持 HLS，打开真实清单后才报告失败。
      media.onerror = () => {
        if (loading.signal.aborted || viewer !== media) return;
        media.onerror = failed;
        media.removeAttribute('src');
        media.load();
        void attachHls(media, source.url, channel, loading.signal);
      };
    }
    media.src = source.url;
  }

  function select(id, retry = false) {
    const channel = listWorkshopChannels().find(item => item.id === id);
    if (channel) return tune(channel, retry);
    close();
  }

  function preview(channel) {
    const source = parseWorkshopVideoSource(channel.source?.url, channel.source?.format);
    return tune({ id: 'preview', label: channel.label, kind: 'custom', source }, true);
  }

  return { element, standby, select, preview, close };
}
