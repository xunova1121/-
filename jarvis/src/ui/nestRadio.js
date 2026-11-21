import jasmine from './assets/nestRadio/jasmine.mp3';
import drum from './assets/nestRadio/flower-drum.mp3';
import cabbage from './assets/nestRadio/little-cabbage.mp3';
import { stopWorkshopHum, workshopHumTitle } from './workshopHum.js';
import './nestRadio.css';

// 来自 workshopTunes 的传统旋律，由本项目编曲录制；三端使用同一组离线音频。
const songs = [
  { title: '茉莉花', url: jasmine },
  { title: '凤阳花鼓', url: drum },
  { title: '小白菜', url: cabbage }
];

export function createNestRadio({ scene, dial, toggle, next, onMusic }) {
  const audio = document.createElement('audio');
  audio.className = 'ws-radio-audio';
  audio.preload = 'none';
  audio.volume = .55;
  audio.hidden = true;
  scene.append(audio);
  let visible = false;
  let nest = true;
  let wanted = false;
  let generation = 0;
  let songIndex = -1;
  let state = 'off';
  let volumeBeforeGreeting = null;

  function softenForGreeting(playing) {
    if (playing && volumeBeforeGreeting === null) {
      volumeBeforeGreeting = audio.volume;
      audio.volume = volumeBeforeGreeting * .22;
    } else if (!playing && volumeBeforeGreeting !== null) {
      audio.volume = volumeBeforeGreeting;
      volumeBeforeGreeting = null;
    }
  }
  scene.addEventListener('workshop:cat-sound', event => softenForGreeting(event.detail.playing));

  function display(value) {
    state = value;
    const song = songs[songIndex]?.title;
    const on = value === 'playing' || value === 'starting';
    const action = on ? '暂停' : value === 'error' ? '重试' : song ? '继续播放' : '播放';
    const label = action + '收音机' + (song ? ' · ' + song : '');
    dial.setAttribute('aria-label', label);
    dial.setAttribute('aria-pressed', String(on));
    dial.dataset.playback = value;
    toggle.textContent = label;
    toggle.setAttribute('aria-pressed', String(on));
  }

  function pause() {
    wanted = false;
    generation++;
    audio.pause();
    display('off');
  }

  function fail(token) {
    if (token !== generation) return;
    wanted = false;
    audio.pause();
    display('error');
  }

  function start(changeSong = false) {
    if (!visible || !nest || document.hidden) return;
    const token = ++generation;
    wanted = true;
    if (scene.dataset.mediaDevice === 'tv') scene.dispatchEvent(new Event('workshop:close-media'));
    stopWorkshopHum();
    onMusic();
    if (songIndex === -1 || changeSong) {
      songIndex = (songIndex + 1) % songs.length;
      audio.src = songs[songIndex].url;
    } else if (audio.error) {
      audio.load();
    }
    display('starting');
    try {
      audio.play().catch(() => fail(token));
    } catch {
      fail(token);
    }
  }

  audio.addEventListener('playing', () => {
    if (wanted && !audio.paused) display('playing');
  });
  audio.addEventListener('pause', () => {
    if (audio.paused && !audio.ended && !audio.error && state !== 'error') {
      wanted = false;
      display('off');
    }
  });
  audio.addEventListener('ended', () => { if (wanted) start(true); });
  audio.addEventListener('error', () => { if (wanted && audio.error) fail(generation); });
  const flip = () => { if (wanted) pause(); else start(); };
  dial.onclick = flip;

  const onSong = () => { if (wanted && workshopHumTitle()) pause(); };
  const onHidden = () => { if (document.hidden) pause(); };
  const onForeground = event => { if (event.detail?.active === false) pause(); };
  scene.addEventListener('workshop:media-opening', event => {
    if (event.detail?.device === 'tv' && wanted) pause();
  });
  display('off');
  return {
    flip,
    next: () => start(true),
    setNest(value) {
      nest = value;
      dial.hidden = toggle.hidden = next.hidden = !value;
      if (!value) {
        pause();
        softenForGreeting(false);
      }
    },
    setVisible(value) {
      if (visible === value) return;
      visible = value;
      if (value) {
        window.addEventListener('jarvis:workshop-song', onSong);
        window.addEventListener('jarvis:foreground', onForeground);
        window.addEventListener('pagehide', pause);
        document.addEventListener('visibilitychange', onHidden);
      } else {
        window.removeEventListener('jarvis:workshop-song', onSong);
        window.removeEventListener('jarvis:foreground', onForeground);
        window.removeEventListener('pagehide', pause);
        document.removeEventListener('visibilitychange', onHidden);
        pause();
        softenForGreeting(false);
      }
    }
  };
}
