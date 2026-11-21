import './nestLiving.css';

// 毫秒从拿壶算起。冲完这一杯后只会偶尔端杯，不会每隔几秒重新烧一壶水。
export function coffeeMoment(elapsed) {
  if (elapsed < 1200) return {phase: 'reach', next: 1200};
  if (elapsed < 4600) return {phase: 'pour', next: 4600};
  if (elapsed < 5700) return {phase: 'set-down', next: 5700};
  if (elapsed < 8200) return {phase: 'sip', next: 8200};
  const cycle = 23500;
  const since = (elapsed - 8200) % cycle;
  return since < 20500
    ? {phase: 'hold', next: elapsed + 20500 - since}
    : {phase: 'sip', next: elapsed + cycle - since};
}

// 裁片来自正在显示的原画，以原画的像素坐标对齐。桌前笔尖和睡觉时的被面有各自支点。
const idleRegions = {
  work: { body: [847,332,205,240], detail: [961,445,93,77] },
  trip: { body: [850,337,198,228], detail: [952,438,99,90] },
  news: { body: [875,332,203,237], detail: [984,436,109,85] },
  sleep: { body: [299,380,181,175], detail: [400,442,274,157] }
};

function part(parent, className) {
  const el = document.createElement('span');
  el.className = className;
  el.setAttribute('aria-hidden','true');
  parent.append(el);
  return el;
}

function cropRegion(el, [x,y,w,h], source) {
  Object.assign(el.style, {
    left: x / 1536 * 100 + '%', top: y / 1024 * 100 + '%',
    width: w / 1536 * 100 + '%', height: h / 1024 * 100 + '%'
  });
  Object.assign(el.firstChild.style, {
    backgroundImage: 'url("' + source + '")',
    backgroundSize: 1536 / w * 100 + '% ' + 1024 / h * 100 + '%',
    backgroundPosition: x / (1536-w) * 100 + '% ' + y / (1024-h) * 100 + '%'
  });
}

export function createNestLiving(floor) {
  const layer = part(floor, 'ws-nest-living');
  layer.hidden = true;
  const body = part(layer, 'ws-nest-idle-patch');
  const detail = part(layer, 'ws-nest-idle-detail');
  for (const patch of [body, detail]) part(patch,'ws-nest-idle-paint');
  part(layer, 'ws-nest-coffee');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let timer = null;
  let activityKey = '';
  let started = 0;
  let previous = '';
  let source = '';
  let visible = false;

  function coffeeStep() {
    clearTimeout(timer);
    timer = null;
    if (!visible || previous !== 'coffee') return;
    const elapsed = performance.now() - started;
    const {phase,next} = coffeeMoment(elapsed);
    const still = reduced.matches || document.body.classList.contains('reduced-motion');
    layer.dataset.coffeePhase = still ? 'pour' : phase;
    if (!still) timer = setTimeout(coffeeStep, Math.max(1, Math.ceil(next - elapsed)));
  }

  function setVisible(shown) {
    if (visible === shown) return;
    visible = shown;
    layer.hidden = !shown;
    if (shown) reduced.addEventListener('change',coffeeStep);
    else {
      reduced.removeEventListener('change',coffeeStep);
      clearTimeout(timer);
      timer = null;
      previous = '';
    }
  }

  function render(pose, state, artwork) {
    if (!visible) return;
    if (pose === 'coffee') {
      const key = (state.manual ? '手动' : '作息') + state.nextAt;
      if (key !== activityKey) {
        activityKey = key;
        started = performance.now();
      } else if (previous === pose && timer !== null) return;
      previous = pose;
      delete layer.dataset.idlePose;
      coffeeStep();
      return;
    }
    if (previous === pose && artwork === source) return;
    previous = pose;
    source = artwork;
    clearTimeout(timer);
    timer = null;
    delete layer.dataset.coffeePhase;
    const regions = idleRegions[pose];
    if (!regions) {
      delete layer.dataset.idlePose;
      return;
    }
    cropRegion(body, regions.body, source);
    cropRegion(detail, regions.detail, source);
    layer.dataset.idlePose = pose;
  }

  return {setVisible, render};
}
