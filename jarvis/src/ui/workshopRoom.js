import { createWorkshopLife } from '../app/workshopLife.js';
import { createWorkshopLifeScene } from './workshopLifeScene.js';
import { playWorkshopHum, stopWorkshopHum } from './workshopHum.js';
import './workshopRoom.css';

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
  for (const [key, label] of choices) menu.append(button(key, label));
  tools.append(lamp, open, menu);
  scene.append(tools);
  let lastActivity;

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
  function escape(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    }
  }
  open.onclick = () => {
    if (!menu.hidden) return dismiss(true);
    menu.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
  };
  lamp.onclick = () => life.perform(life.snapshot().lampOn ? 'lamp-off' : 'lamp-on');
  menu.onclick = (event) => {
    const cmd = event.target.closest('button')?.dataset.roomAction;
    if (!cmd || !life.perform(cmd)) return;
    if (cmd === 'sing') playWorkshopHum();
    dismiss(true);
  };

  return {
    render(presentingWork, confirmedShred) {
      life.setBusy(presentingWork);
      const state = life.snapshot();
      if (lastActivity === 'sing' && state.activity !== 'sing') stopWorkshopHum();
      lastActivity = state.activity;
      display.render(presentingWork && confirmedShred ? { ...state, activity: 'shred' } : state);
      if (lamp.getAttribute('aria-pressed') !== String(state.lampOn)) {
        lamp.setAttribute('aria-pressed', String(state.lampOn));
        lamp.textContent = state.lampOn ? '关灯' : '开灯';
        lamp.title = state.lampOn ? '关闭工作台台灯' : '打开工作台台灯';
      }
      for (const el of menu.children) el.disabled = presentingWork && el.dataset.roomAction !== 'lamp-auto';
      if (scene.dataset.lifePose === 'lamp') return { ...state, label: state.lampOn ? '正在打开台灯' : '正在关掉台灯' };
      return state;
    },
    setVisible(on) {
      life.setVisible(on);
      if (!on) {
        life.setBusy(false);
        dismiss(false);
        display.suspend();
        if (lastActivity === 'sing') stopWorkshopHum();
      }
    }
  };
}
