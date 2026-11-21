import { createCatBehavior } from '../app/nestCat.js';
import { createNestCatSound } from './nestCatSound.js';
import { mediaNode } from './workshopMediaView.js';
import sleepLit from './assets/nestRoom/sleepcat-lit.webp';
import sleepDark from './assets/nestRoom/sleepcat-dark.webp';
import groomLit from './assets/nestRoom/groomcat-lit.webp';
import groomDark from './assets/nestRoom/groomcat-dark.webp';
import sniffLit from './assets/nestRoom/sniffcat-lit.webp';
import sniffDark from './assets/nestRoom/sniffcat-dark.webp';
import './nestCat.css';

const patches = {
  asleep: [sleepLit, sleepDark], deep: [sleepLit, sleepDark], listening: [sleepLit, sleepDark],
  groom: [groomLit, groomDark], rest: [groomLit, groomDark], sniff: [sniffLit, sniffDark]
};
const labels = {
  asleep: '蜷在地毯上睡觉', listening: '耳朵轻轻动了一下', deep: '又把头埋进尾巴',
  alert: '醒着，正四下张望', sniff: '正在闻未央的手', welcome: '主动蹭了蹭未央的手',
  pet: '眯着眼睛让未央轻挠', rest: '收回爪子，开始洗脸', groom: '正慢慢舔着前爪'
};

function read(key) {
  try { return globalThis.localStorage?.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* 禁用存储时，本次选择仍然有效。 */ }
}

function createCatPicture(floor) {
  const art = floor.querySelector('.ws-nest-art');
  const picture = mediaNode('div', 'ws-nest-cat-motion');
  picture.setAttribute('aria-hidden', 'true');
  const layers = ['body', 'face', 'hand'].map(part => {
    const layer = mediaNode('img', 'ws-nest-cat-' + part);
    layer.alt = '';
    layer.draggable = false;
    picture.append(layer);
    return layer;
  });
  floor.append(picture);
  let pose, dark, lastImage;
  function draw() {
    const replacement = patches[pose]?.[dark ? 1 : 0];
    const url = replacement || art?.getAttribute('src');
    if (url && lastImage !== url) {
      for (const layer of layers) layer.src = url;
      lastImage = url;
    }
    picture.hidden = !url;
    picture.dataset.source = replacement ? 'patch' : 'room';
    picture.dataset.pose = pose;
  }
  const observer = new MutationObserver(draw);
  return {
    draw(nextPose, nextDark) { pose = nextPose; dark = nextDark; draw(); },
    setVisible(on) {
      if (on && art) { observer.observe(art, { attributes: true, attributeFilter: ['src'] }); }
      else { observer.disconnect(); picture.hidden = true; }
    }
  };
}

export function createNestCat({ scene, floor, closePanels, onChange }) {
  const behavior = createCatBehavior({ read, write });
  const picture = createCatPicture(floor);
  const sound = createNestCatSound(scene);
  const muteKey = 'jarvis.nest.cat.muted.v1';
  let muted = read(muteKey) === '1';
  const soundButton = mediaNode('button', 'ws-nest-cat-audio', '猫咪互动声音');
  soundButton.type = 'button';
  soundButton.setAttribute('aria-pressed', String(!muted));
  scene.querySelector('.ws-room-menu')?.append(soundButton);
  soundButton.onclick = () => {
    muted = !muted;
    write(muteKey, muted ? '1' : '0');
    soundButton.setAttribute('aria-pressed', String(!muted));
    if (muted) sound.release();
  };

  let visible = false, busy = false, dark = false, allowVisit = true, lastActivity = '';
  let requested = false, lastState, timer, timerAt = 0;

  function clearTimer() {
    clearTimeout(timer);
    timerAt = 0;
  }
  function update() {
    const now = new Date();
    behavior.advance(now);
    if (visible && !document.hidden && !busy && allowVisit && lastActivity === 'cat-visit') behavior.visitOnce(now);
    const cat = behavior.snapshot(now);
    if (visible && !document.hidden) picture.draw(cat.state, dark);
    scene.dataset.catState = cat.state;
    if (lastState !== cat.state) {
      if (cat.state === 'pet' && requested && !muted) sound.play();
      if (!cat.withCat) { requested = false; sound.stop(); }
      lastState = cat.state;
    }
    if (visible && !document.hidden && timerAt !== cat.nextAt) {
      clearTimer();
      timerAt = cat.nextAt;
      timer = setTimeout(changed, Math.max(1, timerAt - now.getTime()));
    }
    const label = labels[cat.state];
    return { state: cat.state, label, withCat: cat.withCat, activityLabel: cat.state === 'pet' ? '未央在地毯上轻挠橘猫的下巴' : label };
  }
  function changed() {
    update();
    onChange?.();
  }
  function close() {
    const now = new Date();
    const hadContact = behavior.snapshot(now).withCat;
    requested = false;
    behavior.leave(now);
    sound.stop();
    if (hadContact) changed();
    else update();
  }
  function open() {
    if (busy || !visible || document.hidden) return;
    closePanels?.();
    const now = new Date();
    const state = behavior.snapshot(now).state;
    if (state === 'alert' || state === 'sniff' || state === 'welcome') {
      requested = true;
      if (!muted) sound.prepare();
    }
    behavior.interact(now);
    changed();
  }
  function render(lifeState, working, options = {}) {
    const leftRoutine = lastActivity === 'cat-visit' && lifeState.activity !== lastActivity;
    const changedManually = lifeState.manual && lastActivity && lifeState.activity !== lastActivity;
    lastActivity = lifeState.activity;
    busy = working;
    dark = options.dark ?? (!lifeState.lampOn && lifeState.night);
    allowVisit = options.allowVisit !== false;
    if (busy || changedManually || !allowVisit || (leftRoutine && !requested)) behavior.leave(new Date());
    return update();
  }
  function syncVisibility() {
    clearTimer();
    const shown = visible && !document.hidden;
    picture.setVisible(shown);
    if (shown) {
      muted = read(muteKey) === '1';
      soundButton.setAttribute('aria-pressed', String(!muted));
      behavior.resume(new Date());
      changed();
    } else {
      requested = false;
      behavior.leave(new Date());
      sound.release();
    }
  }
  function setVisible(on) {
    if (visible === on) return;
    visible = on;
    if (on) document.addEventListener('visibilitychange', syncVisibility);
    else document.removeEventListener('visibilitychange', syncVisibility);
    syncVisibility();
  }
  return { render, open, close, isOpen: () => behavior.snapshot(new Date()).withCat, setVisible, dispose: () => setVisible(false) };
}
