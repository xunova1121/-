import { workshopTvPlayers } from '../../shared/workshopTv.js';
import { listWorkshopChannels } from './workshopMediaChannels.js';
import { parseWorkshopVideoSource } from '../../shared/workshopVideoSource.js';
import { watchWorkshopVideo } from './workshopVideoHealth.js';
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
export function createWorkshopTvPlayer({ getPlayers, openSources, loadHls = () => import('hls.js') } = {}) {
  const element = playerPart('div', 'ws-tv-player');
  const standby = playerPart('div', 'ws-tv-standby');
  element.hidden = standby.hidden = true;
  let request, current, viewer, hls, health, connectionTimer;

  function clearScreen() {
    clearTimeout(connectionTimer);
    health?.dispose();
    health = null;
    if (viewer) {
      viewer.onerror = viewer.onload = null;
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
    request?.abort();
    clearScreen();
    const retry = action('重新连接', () => tune(channel, true));
    const buttons = [retry];
    if (offerClip) buttons.push(action('看未央风景短片', () => playClip(channel, '直播暂不可用')));
    standby.replaceChildren(signalCard(channel.label, detail, buttons));
    standby.hidden = false;
  }

  function monitor(video, host, channel, clip, onTimeout) {
    const feedback = playerPart('div', 'ws-tv-feedback');
    host.append(feedback);
    let previous = '', lastPlay;
    return watchWorkshopVideo(video, {
      loadingText: clip ? '正在打开风景短片…' : '正在连接频道…',
      show(detail, play) {
        if (!feedback.hidden && previous === detail && lastPlay === play) return;
        previous = detail;
        lastPlay = play;
        const buttons = play ? [action('点击播放', play)] : [];
        if (!clip) buttons.push(action('看未央风景短片', () => playClip(channel, '已切换到短片')));
        feedback.replaceChildren(signalCard(clip ? '未央风景短片' : channel.label, detail, buttons));
        feedback.hidden = false;
      },
      hide() { if (!feedback.hidden) feedback.hidden = true; },
      timeout: onTimeout
    });
  }

  function playClip(channel, reason) {
    request?.abort();
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
    const clipFailed = () => {
      if (viewer !== clip) return;
      if (alternate) {
        clip.src = alternate;
        alternate = null;
        health.loading();
        health.tryPlay();
      } else {
        problem(channel, '本机未能播放风景短片', false);
      }
    };
    viewer = clip;
    const recover = reason === '直播未接入' ? [] : [action('重试直播', () => tune(channel, true))];
    standby.replaceChildren(clip, signalCard(title, channel.label + ' ' + reason, recover));
    standby.hidden = false;
    health = monitor(clip, standby, channel, true, clipFailed);
    clip.onerror = clipFailed;
    clip.src = webmFirst ? meadowWebm : meadowMp4;
    health.tryPlay();
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
      health.tryPlay();
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
      connectionTimer = setTimeout(() => {
        if (!loading.signal.aborted) problem(channel, '读取频道配置超时', true);
      }, 12000);
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
    if (source.type === 'embed') {
      const card = signalCard(channel.label, '正在打开频道播放器…');
      card.className += ' ws-tv-feedback';
      element.append(card);
      // 跨域 iframe 的 load 只能证明导航结束，无法读取或判断其中的视频帧。
      media.onload = () => {
        if (viewer !== media || loading.signal.aborted) return;
        clearTimeout(connectionTimer);
        card.hidden = true;
      };
      connectionTimer = setTimeout(() => {
        if (viewer === media) problem(channel, '打开频道播放器超时', true);
      }, 12000);
      media.src = source.url;
      return;
    }
    const path = new URL(source.url).pathname;
    const isHls = source.format === 'hls' || /\.m3u8$/i.test(path);
    // 部署方给央视配置的签名直链可能只有路径和查询参数，先直放，失败时试一次 HLS。
    const unknown = !source.format && !/\.[a-z0-9]{2,5}$/i.test(path);
    let tryingHls = false;
    function useHls() {
      tryingHls = true;
      media.onerror = failed;
      media.removeAttribute('src');
      media.load();
      health.loading();
      return attachHls(media, source.url, channel, loading.signal);
    }
    const couldFallback = () => !tryingHls && (isHls || unknown);
    health = monitor(media, element, channel, false, stalled => {
      if (!stalled && couldFallback()) { void useHls(); return; }
      problem(channel, stalled ? '频道画面已停止更新，请重试或更换视频源' : '等待频道画面超时，请重试或更换视频源', true);
    });
    if (isHls && !media.canPlayType('application/vnd.apple.mpegurl')) {
      tryingHls = true;
      await attachHls(media, source.url, channel, loading.signal);
      return;
    }
    media.onerror = () => {
      if (loading.signal.aborted || viewer !== media) return;
      if (couldFallback()) void useHls();
      else failed();
    };
    media.src = source.url;
    health.tryPlay();
  }

  function select(id, retry = false) {
    const channel = listWorkshopChannels().find(item => item.id === id);
    if (channel) return tune(channel, retry);
    close();
    if (id == null) {
      standby.replaceChildren(signalCard('暂无频道', '在视频源中添加直播地址，或恢复已移除的默认频道。',
        [action('添加或恢复频道', openSources)]));
      standby.hidden = false;
    }
  }

  function preview(channel) {
    const source = parseWorkshopVideoSource(channel.source?.url, channel.source?.format);
    return tune({ id: 'preview', label: channel.label, kind: 'custom', source }, true);
  }

  return { element, standby, select, preview, close };
}
