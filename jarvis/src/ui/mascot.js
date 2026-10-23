import './mascot.css';

export const MASCOT_LABELS = {
  idle: '陪伴', wink: '眨眼', rub: '搓手期待', think: '思考',
  wave: '挥手', shy: '害羞', love: '比心', dance: '跳舞', pet: '摸摸头', sleep: '睡觉', run: '忙碌查找', happy: '高兴', spin: '转圈', listen: '正在听'
};

export function poseForEmotion(value) {
  if (/开心|高兴|喜悦|愉悦|兴奋|happy|excited|joy/i.test(value)) return 'happy';
  if (/困|睡|sleep|tired/i.test(value)) return 'sleep';
  if (/好奇|思考|专注|疑|警|curious|think|alert|confus/i.test(value)) return 'think';
  if (/聆听|listen/i.test(value)) return 'listen';
  if (/亲和|安抚/i.test(value)) return 'wink';
  if (/期待|expect|anticipat/i.test(value)) return 'rub';
  if (/俏皮|调皮|wink|playful/i.test(value)) return 'wink';
  return 'idle';
}

export function poseForTask(state, detail = '') {
  if (state === 'processing') return /查|搜|读|抓取|下载/.test(detail) ? 'run' : 'rub';
  return { listening: 'think', done: 'happy', error: 'think', idle: 'idle' }[state] || 'idle';
}

export function setMascotState(el, state) {
  state = Object.hasOwn(MASCOT_LABELS, state) ? state : 'idle';
  el.dataset.state = state;
  el.setAttribute('aria-label', `未央：${MASCOT_LABELS[state]}`);
  el.title = MASCOT_LABELS[state];
}

export function createMascot(state = 'idle') {
  const el = document.createElement('span');
  el.className = 'wy-mascot';
  el.setAttribute('role', 'img');
  setMascotState(el, state);
  return el;
}

/** 只更新工作状态，不启动 WebGL；手机上的小图标由 CSS 动画驱动。 */
export function initMascots() {
  const marks = () => [...document.querySelectorAll('.brand-mark, .as-logo, .welcome-hero .cloud, .drawer-logo, .wb-mark, .wb-hero-mark')];
  for (const mark of marks()) {
    mark.classList.add('wy-brand');
    if (mark.matches('.brand-mark, .welcome-hero .cloud, .wb-mark, .wb-hero-mark')) { mark.removeAttribute('aria-hidden'); mark.setAttribute('role', 'button'); mark.tabIndex = 0; mark.setAttribute('aria-label', '打开未央，和我说话'); mark.closest('.welcome-hero')?.removeAttribute('aria-hidden'); }
    mark.replaceChildren(createMascot(mark.matches('.as-logo') ? 'wave' : 'idle'));
  }
  let task = 'idle';
  let sleeping = false;
  let timer;
  const refresh = () => {
    const state = sleeping && task === 'idle' ? 'sleep' : document.body.classList.contains('speaking') ? 'happy' : document.body.classList.contains('voice-on') && task === 'idle' ? 'listen' : task;
    for (const mark of marks()) {
      if (mark.matches('.as-logo')) continue;
      if (!mark.querySelector('.wy-mascot')) { mark.classList.add('wy-brand'); mark.replaceChildren(createMascot()); }
      if (mark.firstElementChild.dataset.state !== state) setMascotState(mark.firstElementChild, state);
    }
  };
  const wake = () => {
    sleeping = false;
    clearTimeout(timer);
    timer = setTimeout(() => { sleeping = true; refresh(); }, 45000);
    refresh();
  };
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('keydown', wake);
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('wy-paused', document.hidden);
    if (!document.hidden) wake();
  });
  const mount = () => {
    for (const mark of marks()) {
      if (!mark.querySelector('.wy-mascot')) {
        mark.classList.add('wy-brand'); mark.replaceChildren(createMascot());
        if (mark.matches('.welcome-hero .cloud')) { mark.setAttribute('role', 'button'); mark.tabIndex = 0; mark.setAttribute('aria-label', '打开未央，和我说话'); mark.closest('.welcome-hero')?.removeAttribute('aria-hidden'); }
      }
    }
  };
  new MutationObserver(mount).observe(document.querySelector('#transcript'), { childList: true });
  wake();
  return { task(state, detail) { task = poseForTask(state, detail); sleeping = false; refresh(); } };
}
