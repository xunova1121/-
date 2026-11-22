import { createWorkshopLife } from '../app/workshopLife.js';
import { nestFurniture, nestIsDark } from './nestArt.js';
import { createWorkshopLifeScene } from './workshopLifeScene.js';
import { playWorkshopHum, stopWorkshopHum, suggestWorkshopTune, workshopHumTitle } from './workshopHum.js';
import { createNestRadio } from './nestRadio.js';
import './workshopRoom.css';

import { localMessageTime } from '../core/localClock.js';
const availableDuringWork = new Set(['discover', 'light', 'lamp-auto', 'photo', 'window', 'folder', 'draft', 'trip', 'tv', 'radio', 'radio-next']);

const choices = [
  ['coffee', '泡咖啡'], ['eat', '吃饭'], ['rest', '歇一会儿'],
  ['tv', '看电视'], ['think', '发会儿呆'], ['sing', '哼支小曲'],
  ['sleep', '睡一觉'], ['shred', '粉碎桌上废纸'], ['auto', '恢复作息'], ['lamp-auto', '灯光随作息']
];

function button(action, label) {
  const el = document.createElement('button');
  el.type = 'button';
  el.dataset.roomAction = action;
  el.textContent = label;
  return el;
}

// 场景互动直接写入房间状态；只有任务回执能把真实文件操作映射到画面中。
export function createWorkshopRoom(scene, floor, onChange) {
  const display = createWorkshopLifeScene(scene, floor, onChange);
  const life = createWorkshopLife({ onChange });
  // 热区和家具一起随镜头平移、缩放。读屏和键盘也能直接操作同一个物件。
  const targets = document.createElement('div');
  targets.className = 'ws-furniture-controls';
  targets.setAttribute('role', 'group');
  targets.setAttribute('aria-label', '工作台家具');
  function furniture(place, label, activate) {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.furniture = place;
    el.setAttribute('aria-label', label);
    el.onclick = activate;
    targets.append(el);
    return el;
  }
  let nest = true;
  const isLit = state => nest ? !nestIsDark(state) : state.lampOn;
  const toggleLight = () => {
    life.perform(isLit(life.snapshot()) ? 'lamp-off' : 'lamp-on');
    dismiss(true);
  };
  const lampTarget = furniture('lamp', '控制桌上的台灯', toggleLight);
  function startActivity(action) {
    if (nest) {
      scene.dispatchEvent(new Event('workshop:nest-interrupt'));
      scene.dispatchEvent(new Event('workshop:close-media'));
    }
    return life.perform(action);
  }
  const cupTarget = furniture('cup', '在桌上泡咖啡', () => startActivity('coffee'));
  const seatTarget = furniture('sofa', '坐到沙发上休息', () => startActivity('rest'));
  let pullStart = null;
  let pulledAt = -Infinity;
  lampTarget.onpointerdown = event => {
    if (!nest || event.button !== 0) return;
    pullStart = event.clientY;
    lampTarget.setPointerCapture(event.pointerId);
  };
  lampTarget.onpointercancel = () => { pullStart = null; };
  lampTarget.onpointerup = event => {
    if (pullStart !== null && event.clientY - pullStart > 12) {
      pulledAt = performance.now();
      toggleLight();
    }
    pullStart = null;
  };
  lampTarget.onclick = () => { if (performance.now() - pulledAt > 350) toggleLight(); };
  floor.append(targets);
  const tools = document.createElement('div');
  tools.className = 'ws-room-tools';
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', '房间互动');
  const lamp = button('light', '开灯');
  const open = button('menu', '房间互动');
  open.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'ws-room-menu';
  menu.hidden = true;
  const schedule = document.createElement('small');
  schedule.className = 'ws-nest-next';
  const discover = button('discover', '找家具');
  menu.append(schedule, discover);
  let revealTimer;
  function clearOutlines() {
    clearTimeout(revealTimer);
    delete scene.dataset.furnitureHints;
  }
  floor.addEventListener('click', clearOutlines, true);
  const nestActions = new Map(nestFurniture);
  const extraActions = [...nestActions].map(([key, label]) => button(key, label));
  menu.append(...extraActions);
  for (const [key, label] of choices) menu.append(button(key, label));
  const dial = furniture('radio', '播放收音机');
  dial.removeAttribute('title');
  const radioToggle = button('radio', '播放收音机');
  const radioNext = button('radio-next', '收音机换首歌');
  menu.append(radioToggle, radioNext);
  const radio = createNestRadio({ scene, dial, toggle: radioToggle, next: radioNext, onMusic() {
    if (life.snapshot().activity === 'sing') life.perform('rest');
  } });
  const listen = button('listen', '听听');
  listen.hidden = true;
  tools.append(listen, lamp, open, menu);
  scene.append(tools);
  let lastActivity;
  let suggested = '';

  function dismiss(restoreFocus) {
    if (!menu.hidden) {
      menu.hidden = true;
      open.setAttribute('aria-expanded', 'false');
      if (restoreFocus) open.focus({ preventScroll: true });
    }
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape, true);
  }
  function outside(event) {
    if (!tools.contains(event.target)) dismiss(false);
  }
  scene.addEventListener('workshop:media-opening', () => { clearOutlines(); dismiss(false); });
  function escape(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    }
  }
  // 手机上输入区在失焦时会收起模型行和软键盘。只看一下互动菜单不应结束正在写的消息。
  const preserveDraftFocus = () => nest && Boolean(scene.closest('.mobile-studio-sheet')) &&
    document.activeElement === document.getElementById('prompt');
  open.onpointerdown = event => {
    if (event.button === 0 && preserveDraftFocus()) event.preventDefault();
  };
  open.onclick = () => {
    if (!menu.hidden) return dismiss(!preserveDraftFocus());
    menu.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
  };
  lamp.onclick = toggleLight;
  listen.onclick = () => {
    const title = suggested;
    if (life.perform('sing')) playWorkshopHum(title);
    dismiss(true);
  };
  menu.onclick = (event) => {
    const cmd = event.target.closest('button')?.dataset.roomAction;
    const title = suggested;
    if (!cmd || cmd === 'listen' || cmd === 'light') return;
    if (nest && cmd === 'discover') {
      dismiss(!preserveDraftFocus());
      clearOutlines();
      scene.dataset.furnitureHints = 'on';
      revealTimer = setTimeout(clearOutlines, 3500);
      return;
    }
    if (nest && (cmd === 'radio' || cmd === 'radio-next')) {
      if (cmd === 'radio') radio.flip();
      else radio.next();
      dismiss(true);
      return;
    }
    if (nest && nestActions.has(cmd)) {
      dismiss(true);
      scene.dispatchEvent(new CustomEvent('workshop:nest-open', { detail: { kind: cmd, trigger: open } }));
      return;
    }
    if (!startActivity(cmd)) return;
    if (cmd === 'sing') playWorkshopHum(title);
    dismiss(true);
    if (cmd === 'tv') scene.dispatchEvent(new Event('workshop:open-tv'));
  };

  return {
    perform: life.perform,
    setNest(value) {
      nest = value;
      clearOutlines();
      discover.hidden = !value;
      cupTarget.setAttribute('aria-label', value ? '在桌上泡咖啡' : '去茶水桌泡咖啡');
      radio.setNest(value);
      dismiss(false);
      for (const action of extraActions) action.hidden = !value;
      schedule.hidden = !value;
    },
    render(presentingWork, confirmedShred) {
      life.setBusy(presentingWork);
      const state = life.snapshot();
      const leftSong = lastActivity === 'sing' && state.activity !== 'sing';
      lastActivity = state.activity;
      if (leftSong) stopWorkshopHum();
      const workOrigin = display.render(presentingWork && confirmedShred ? { ...state, activity: 'shred' } : state);
      const compact = nest;
      if (compact && lamp.parentElement !== menu) menu.prepend(lamp, listen);
      else if (!compact && lamp.parentElement === menu) tools.prepend(listen, lamp);
      const menuLabel = compact ? '互动' : '房间互动';
      if (open.textContent !== menuLabel) open.textContent = menuLabel;
      if (nest && state.nextAt) {
        const nextTime = localMessageTime(new Date(state.nextAt));
        const next = (state.manual ? '恢复作息 ' : '接下来 ') + nextTime + ' · ' + state.nextLabel;
        if (schedule.textContent !== next) schedule.textContent = next;
      }
      const lit = isLit(state);
      if (lamp.getAttribute('aria-pressed') !== String(lit)) {
        lamp.setAttribute('aria-pressed', String(lit));
        lampTarget.setAttribute('aria-pressed', String(lit));
        lamp.textContent = lit ? '关灯' : '开灯';
        lamp.title = lit ? '关闭工作台台灯' : '打开工作台台灯';
      }
      cupTarget.disabled = seatTarget.disabled = Boolean(presentingWork);
      for (const el of menu.querySelectorAll('button[data-room-action]')) {
        el.disabled = Boolean(presentingWork) && !availableDuringWork.has(el.dataset.roomAction);
      }
      let label = state.label;
      const playing = workshopHumTitle();
      const automaticSong = state.activity === 'sing' && !state.manual;
      suggested = automaticSong ? suggested || suggestWorkshopTune() : '';
      listen.hidden = !suggested || Boolean(playing);
      if (suggested) listen.textContent = '听《' + suggested + '》';
      if (state.activity === 'sing' && (playing || suggested)) label = '正在哼《' + (playing || suggested) + '》';
      if (scene.dataset.lifePose === 'lamp') label = state.lampOn ? '正在打开台灯' : '正在关掉台灯';
      return { ...state, workOrigin, label };
    },
    setVisible(on) {
      radio.setVisible(on);
      if (on) window.addEventListener('jarvis:workshop-song', onChange);
      else window.removeEventListener('jarvis:workshop-song', onChange);
      life.setVisible(on);
      if (!on) {
        clearOutlines();
        life.setBusy(false);
        dismiss(false);
        display.suspend();
        suggested = '';
        if (lastActivity === 'sing') stopWorkshopHum();
      }
    }
  };
}
