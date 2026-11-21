import { lyricLines } from '../../shared/musicAsset.js';
import './songCard.css';
import { saveFile } from './saveFile.js';
// 只保留一首已载入歌曲，切换/离开会话时暂停并释放Blob，不累积音频内存。
let current = null;
let generation = 0;
const node = (tag, text, className) => Object.assign(document.createElement(tag), { ...(text !== undefined && { textContent: text }), ...(className && { className }) });
export function createSongCard(path, load) {
  const card = node('section', undefined, 'song-card');
  card.setAttribute('aria-label', '歌曲播放器');
  const header = node('div', undefined, 'song-head');
  const cover = node('span', '♫', 'song-cover');
  cover.setAttribute('aria-label', '歌曲图标');
  const title = node('strong', path.split('/').pop().replace(/\.[^.]+$/, ''));
  const start = node('button', '播放歌曲'); start.type = 'button';
  header.append(cover, title, start);
  const audio = node('audio', undefined, 'gen-audio');
  audio.controls = true; audio.preload = 'metadata'; audio.hidden = true;
  const caption = node('p', '点击播放，载入对应音频与歌词。', 'song-note');
  const lyrics = node('div', undefined, 'song-lyrics');
  lyrics.tabIndex = 0; lyrics.setAttribute('aria-label', '歌词，可上下滚动');
  const follow = node('button', '跟随歌词'); follow.type = 'button'; follow.hidden = true;
  const download = node('button', '下载音频'); download.type = 'button';
  download.onclick = async () => {
    download.disabled = true;
    try { caption.textContent = await saveFile((await load(path)).blob, path.split('/').pop()); }
    catch (error) { caption.textContent = `下载未完成：${error.message}`; }
    finally { download.disabled = false; }
  };
  card.append(header, audio, caption, lyrics, follow, download);
  let rows = [], active = -1, manual = false, url = null;
  const pauseFollow = () => { manual = true; };
  lyrics.addEventListener('wheel', pauseFollow, { passive: true });
  lyrics.addEventListener('pointerdown', pauseFollow);
  lyrics.addEventListener('keydown', pauseFollow);
  function track() {
    let index = -1, latest = -1;
    for (let i = 0; i < rows.length; i++) {
      for (const time of rows[i].times) if (time <= audio.currentTime && time >= latest) { index = i; latest = time; }
    }
    if (index === active) return;
    if (active >= 0) lyrics.children[active].removeAttribute('aria-current');
    active = index;
    if (active < 0) return;
    const line = lyrics.children[active]; line.setAttribute('aria-current', 'true');
    if (!manual) lyrics.scrollTop += line.getBoundingClientRect().top - lyrics.getBoundingClientRect().top - lyrics.clientHeight / 2 + line.clientHeight / 2;
  }
  follow.onclick = () => { manual = false; active = -1; track(); };
  audio.addEventListener('timeupdate', track);
  audio.addEventListener('seeked', track);
  audio.addEventListener('play', () => { start.textContent = '暂停'; });
  audio.addEventListener('pause', () => { start.textContent = '播放'; });
  audio.addEventListener('ended', () => { start.textContent = '重新播放'; });
  audio.addEventListener('error', () => { caption.textContent = '音频播放失败，可通过下方文件入口打开原件。'; });
  const release = () => {
    audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true;
    if (url) URL.revokeObjectURL(url); url = null;
    start.textContent = '播放歌曲'; observer.disconnect();
  };
  const observer = new MutationObserver(() => { if (!card.isConnected && current?.card === card) { release(); current = null; generation++; } });
  start.onclick = async () => {
    if (url) {
      if (!audio.paused) { audio.pause(); return; }
      try { await audio.play(); } catch { caption.textContent = '播放未启动，请点击播放器重试。'; }
      return;
    }
    const ticket = ++generation;
    current?.release(); current = null;
    start.disabled = true; start.textContent = '载入中…';
    try {
      const asset = await load(path);
      if (ticket !== generation || !card.isConnected) return;
      if (asset.title) title.textContent = asset.title;
      rows = asset.lyrics ? lyricLines(asset.lyrics) : []; active = -1; manual = false;
      lyrics.replaceChildren(...rows.map((row) => node('p', row.text || '\u00a0')));
      const timed = rows.some((row) => row.times.length);
      follow.hidden = !timed;
      caption.textContent = asset.note || (timed ? '按歌词时间标记跟随；手动滚动后可点“跟随歌词”恢复。' : '歌词原稿 · 没有逐行时间戳，可手动滚动。');
      if (asset.lyrics?.split(/\r?\n/).length > 300) caption.textContent += ' 卡片只展示前300行。';
      url = URL.createObjectURL(asset.blob); audio.src = url; audio.hidden = false;
      current = { card, release };
      observer.observe(document.body, { childList: true, subtree: true });
      try { await audio.play(); } catch { caption.textContent += ' 点击播放器开始播放。'; }
    } catch (error) {
      if (ticket === generation && card.isConnected) caption.textContent = `歌曲未载入：${error.message}。可打开下方原文件。`;
    } finally {
      start.disabled = false;
      if (!url) start.textContent = '播放歌曲';
    }
  };
  return card;
}
