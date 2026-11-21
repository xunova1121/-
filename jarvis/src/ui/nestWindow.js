import openLit from './assets/nestRoom/window-open-lit.webp';
import openDark from './assets/nestRoom/window-open-off.webp';
import outsideDay from './assets/nestRoom/outside-day.webp';
import outsideNight from './assets/nestRoom/outside-night.webp';
import { workshopChannelScope } from './workshopMediaChannels.js';
import './nestWindow.css';

const latchPrefix = 'jarvis.nest.window.v1:';
const validModes = ['ajar', 'open', 'latched'];
const isDaylight = () => {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18;
};

function windowMode(scope) {
  try {
    const mode = localStorage.getItem(latchPrefix + scope);
    return validModes.includes(mode) ? mode : 'ajar';
  } catch { return 'ajar'; }
}

function actionButton(label, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.dataset.nestWindow = action;
  return el;
}

export function createNestWindow({ world, panel, art }) {
  const sash = document.createElement('div');
  sash.className = 'nest-window-glass';
  sash.hidden = true;
  sash.setAttribute('aria-hidden', 'true');
  const glass = document.createElement('img');
  glass.alt = '';
  const drape = glass.cloneNode();
  drape.className = 'nest-window-drape';
  sash.append(glass, drape);
  art.after(sash);

  const controls = document.createElement('div');
  controls.className = 'nest-window-menu';
  const toggle = actionButton('', 'toggle');
  const latch = actionButton('关窗落闩', 'latch');
  const look = actionButton('看看窗外', 'look');
  controls.append(toggle, latch, look);
  const view = document.createElement('div');
  view.className = 'nest-window-view';
  const landscape = document.createElement('img');
  const back = actionButton('回到窗边', 'back');
  view.append(landscape);

  let scope = '';
  let mode = 'ajar';
  let lit = true;
  let visible = false;
  let inViewport = !('IntersectionObserver' in window);
  let gust = false;
  let nextTimer, stopTimer, opener;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => reduced.matches || document.body.classList.contains('reduced-motion');

  function draw() {
    const open = mode === 'open' || gust;
    world.dataset.windowState = gust && mode === 'ajar' ? 'breeze' : mode;
    sash.classList.toggle('nest-window-open', open);
    sash.classList.toggle('nest-window-wind', gust);
    if (open) {
      const src = lit ? openLit : openDark;
      if (glass.getAttribute('src') !== src) glass.src = drape.src = src;
    }
    toggle.textContent = open ? '关窗落闩' : '推开窗';
    latch.hidden = mode !== 'ajar' || gust;
  }

  function stopWind() {
    clearTimeout(stopTimer);
    gust = false;
    draw();
  }

  function canBlow() {
    return visible && inViewport && !document.hidden && mode !== 'latched' && !still();
  }

  function startWind() {
    clearTimeout(stopTimer);
    gust = true;
    draw();
    stopTimer = setTimeout(stopWind, 5400);
  }

  function planWind() {
    clearTimeout(nextTimer);
    if (!canBlow()) { stopWind(); return; }
    const interval = isDaylight() ? 75_000 : 155_000;
    nextTimer = setTimeout(() => {
      if (canBlow() && !panel.isOpen()) startWind();
      planWind();
    }, interval * (1 + Math.random()));
  }

  function readChoice() {
    scope = workshopChannelScope();
    mode = windowMode(scope);
    stopWind();
    planWind();
  }
  function choose(modeToSave) {
    if (scope !== workshopChannelScope()) readChoice();
    mode = modeToSave;
    try { localStorage.setItem(latchPrefix + scope, mode); } catch { /* 本次打开仍可操作。 */ }
    stopWind();
    if (mode === 'open' && canBlow()) startWind();
    planWind();
  }
  function storageChanged(e) {
    if (e.key === latchPrefix + scope || e.key === null) readChoice();
  }
  function open(trigger = opener) {
    if (scope !== workshopChannelScope()) readChoice();
    opener = trigger;
    panel.open({ title: '窗边', kind: 'window', content: controls, trigger: opener });
    draw();
  }
  function updateView() {
    const day = isDaylight();
    const src = day ? outsideDay : outsideNight;
    if (landscape.getAttribute('src') !== src) {
      landscape.src = src;
      landscape.alt = day ? '从窗边望出去，花园小径通向山谷和红瓦小镇。' : '月光照着花园小径，山谷里的小镇亮起几扇灯。';
    }
  }
  toggle.onclick = () => choose(mode === 'open' || gust ? 'latched' : 'open');
  latch.onclick = () => choose('latched');
  look.onclick = () => {
    updateView();
    panel.open({ title: '窗外', kind: 'view', content: view, actions: back, trigger: opener });
    back.focus({ preventScroll: true });
  };
  back.onclick = () => {
    open();
    look.focus({ preventScroll: true });
  };

  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => {
    inViewport = entry.isIntersecting;
    planWind();
  }) : null;
  const observeMotion = on => {
    const add = on ? 'addEventListener' : 'removeEventListener';
    if (reduced[add]) reduced[add]('change', planWind);
    else reduced[on ? 'addListener' : 'removeListener'](planWind);
  };

  function setVisible(on) {
    if (visible === on) return;
    visible = on;
    sash.hidden = !on;
    const listen = on ? 'addEventListener' : 'removeEventListener';
    document[listen]('visibilitychange', planWind);
    window[listen]('storage', storageChanged);
    observeMotion(on);
    if (on) {
      observer?.observe(world);
      readChoice();
    } else {
      observer?.disconnect();
      inViewport = !observer;
      clearTimeout(nextTimer);
      stopWind();
    }
  }
  return {
    open, setVisible,
    render({ lampOn }) {
      if (visible && scope !== workshopChannelScope()) readChoice();
      if (lit !== lampOn) { lit = lampOn; draw(); }
      if (panel.isOpen('view')) updateView();
    },
    dispose() { setVisible(false); sash.remove(); }
  };
}
