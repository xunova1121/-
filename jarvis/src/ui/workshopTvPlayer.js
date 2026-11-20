import { WORKSHOP_TV_CHANNELS, workshopTvPlayers } from '../../shared/workshopTv.js';
import './workshopTvPlayer.css';

// 只在用户打开电视时创建播放器。关面板、切频道或进入后台都会释放旧媒体。
export function createWorkshopTvPlayer({ getPlayers } = {}) {
  const element = document.createElement('div');
  element.className = 'ws-tv-player';
  element.hidden = true;
  let request;
  let current;

  function close() {
    request?.abort();
    request = null;
    current = null;
    const video = element.querySelector('video');
    if (video) {
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    element.replaceChildren();
    element.hidden = true;
  }

  async function select(channelId) {
    if (current === channelId) return;
    close();
    const channel = WORKSHOP_TV_CHANNELS.find(ch => ch.id === channelId);
    if (!channel || !getPlayers) return;
    current = channelId;
    const loading = new AbortController();
    request = loading;
    let configured;
    try { configured = await getPlayers(loading.signal); } catch { return; }
    if (loading.signal.aborted) return;
    const source = workshopTvPlayers(configured)[channelId];
    if (!source) return;
    let viewer;
    if (source.type === 'media') {
      viewer = document.createElement('video');
      viewer.controls = true;
      viewer.muted = true;
      viewer.playsInline = true;
      viewer.preload = 'metadata';
      viewer.setAttribute('aria-label', channel.name);
      viewer.onerror = () => {
        if (!loading.signal.aborted) element.textContent = '此设备暂时无法播放，请打开频道官网观看。';
      };
    } else {
      viewer = document.createElement('iframe');
      viewer.title = channel.name + '授权播放器';
      viewer.setAttribute('sandbox', 'allow-scripts allow-presentation');
      viewer.allow = 'fullscreen';
      viewer.allowFullscreen = true;
      viewer.referrerPolicy = 'strict-origin-when-cross-origin';
    }
    viewer.src = source.url;
    element.replaceChildren(viewer);
    element.hidden = false;
  }

  return { element, select, close };
}
