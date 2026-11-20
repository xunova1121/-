import './workshopLifeScene.css';
import { routineStations, feetInRoom, walkAcrossRoom } from './workshopMotion.js';

// 百分比坐标以完整车间为准。每个动作的两帧来自同一组角色、道具和镜头。
const poses = {
  coffee: { x: 28, ground: 81, width: 18, col: 0, row: 0, place: 'kitchen' },
  eat:    { x: 28, ground: 81, width: 18, col: 1, row: 0, place: 'kitchen' },
  sleep:  { x: 49, ground: 88, width: 22, col: 2, row: 0, place: 'lounge' },
  rest:   { x: 49, ground: 86, width: 18, col: 0, row: 1, place: 'lounge' },
  tv:     { x: 79, ground: 82, width: 21, col: 1, row: 1, place: 'television' },
  think:  { x: 49, ground: 86, width: 16, col: 2, row: 1, place: 'lounge' },
  sing:   { x: 62, ground: 89, width: 17, col: 0, row: 2, place: 'music' },
  shred:  { x: 10, ground: 79, width: 17, col: 1, row: 2, place: 'shredder' },
  lamp:   { x: 66, ground: 80, width: 17, col: 2, row: 2, place: 'switch' }
};

function part(parent, className) {
  const el = document.createElement('span');
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  parent.append(el);
  return el;
}

export function createWorkshopLifeScene(scene, floor, onChange = () => {}) {
  const workActor = floor.querySelector('.ws-actor');
  const furniture = part(floor, 'ws-life-furniture');
  for (const place of ['kitchen', 'television', 'lounge', 'shredder']) {
    part(furniture, 'ws-room-item').dataset.place = place;
  }
  const actor = part(floor, 'ws-life-actor');
  part(actor, 'ws-life-shadow');
  part(actor, 'ws-life-pose');
  part(actor, 'ws-life-walker');
  part(actor, 'ws-life-steam');
  part(actor, 'ws-life-notes').textContent = '♪';
  part(floor, 'ws-room-light');

  let walk = null;
  let lampTimer = null;
  let latest = null;
  let displayed = '';
  let workOrigin = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => reduced.matches || document.body.classList.contains('reduced-motion');

  function applyLamp() {
    scene.dataset.lampLit = latest.lampOn ? 'on' : 'off';
  }

  function stopWalk() {
    if (walk) {
      walk.onfinish = null;
      walk.cancel();
      walk = null;
    }
    scene.dataset.lifePhase = 'settled';
  }

  function show(pose) {
    if (pose === displayed) return;
    const leavingFurniture = Object.hasOwn(poses, displayed);
    const previous = displayed && feetInRoom(leavingFurniture ? actor : workActor, floor);
    stopWalk();
    displayed = pose;
    scene.dataset.lifePose = pose;
    const target = poses[pose];
    if (!target) {
      if (leavingFurniture) workOrigin = previous;
      delete scene.dataset.lifePlace;
      return;
    }
    scene.dataset.lifePlace = target.place;
    scene.style.setProperty('--life-x', target.x + '%');
    scene.style.setProperty('--life-ground', target.ground + '%');
    scene.style.setProperty('--life-width', target.width + '%');
    actor.style.setProperty('--life-frame-a', (target.col * 40) + '%');
    actor.style.setProperty('--life-frame-b', (target.col * 40 + 20) + '%');
    actor.style.setProperty('--life-frame-y', (target.row * 50) + '%');
    if (!previous || still() || !actor.animate || !CSS.supports('translate', '1px')) return;

    // 按世界坐标行走。远近镜头共用同一脚底锚点，快速换动作从眼前位置转向。
    const dx = (previous.x - target.x / 100) * floor.offsetWidth;
    const dy = (previous.y - target.ground / 100) * floor.offsetHeight;
    const distance = Math.hypot(dx, dy);
    if (distance < 4) return;
    actor.dataset.facing = dx > 0 ? 'left' : 'right';
    scene.dataset.lifePhase = 'walking';
    walk = walkAcrossRoom(actor, dx, dy, Math.min(850, Math.max(250, distance * 3)));
    walk.onfinish = () => {
      stopWalk();
      if (pose === 'lamp') applyLamp();
    };
  }

  function suspend() {
    clearTimeout(lampTimer);
    lampTimer = null;
    stopWalk();
    latest = null;
    displayed = '';
    workOrigin = null;
  }

  function render(state) {
    const activity = Object.hasOwn(poses, state.activity) || Object.hasOwn(routineStations, state.activity) ? state.activity : 'work';
    const switchLamp = latest && state.lightMode !== 'auto' && latest.lampOn !== state.lampOn;
    const changed = latest?.activity !== activity;
    latest = state;
    scene.dataset.lamp = state.lampOn ? 'on' : 'off';
    scene.dataset.lifePeriod = state.period;
    scene.dataset.lifeActivity = activity;
    if (changed || switchLamp || activity === 'work') {
      clearTimeout(lampTimer);
      lampTimer = null;
    }
    if (switchLamp && activity !== 'work' && !still()) {
      show('lamp');
      if (!walk) applyLamp();
      lampTimer = setTimeout(() => {
        lampTimer = null;
        show(latest.activity);
        onChange();
      }, 1850);
    } else if (lampTimer === null) {
      applyLamp();
      show(activity);
    }
    const origin = workOrigin;
    workOrigin = null;
    return origin;
  }

  return { render, suspend };
}
