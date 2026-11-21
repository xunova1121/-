import { createCatBehavior } from '../app/nestCat.js';
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
const copy = {
  asleep: ['蜷在地毯上睡觉', '它把鼻子埋在尾巴里。', '轻声唤它', '让它继续睡'],
  listening: ['耳朵轻轻动了一下', '等等看，它可能还想睡。', '', '让它继续睡'],
  deep: ['它又把头埋进尾巴', '等它睡醒再来陪它吧。', '', '让它继续睡'],
  alert: ['醒着，正四下张望', '停住手，等橘猫自己靠近。', '伸手让它闻闻', '安静陪着'],
  sniff: ['正在闻未央的手', '未央把手放低，留给它一点时间。', '', '把手收回'],
  welcome: ['主动蹭了蹭未央的手', '它仰起头，把下巴送过来。', '轻挠下巴', '收回手'],
  pet: ['眯着眼睛让未央轻挠', '它把头靠过来，眼睛眯成一条缝。', '再摸一下', '让它自在一会儿'],
  rest: ['收回爪子，开始洗脸', '橘猫低头舔起前爪，未央给它留点空间。', '', '让它自己待着'],
  groom: ['正慢慢舔着前爪', '橘猫还在梳理毛发。', '', '安静陪着']
};

function choice(key, label) {
  const el = mediaNode('button', '', label);
  el.type = 'button';
  el.dataset.catChoice = key;
  return el;
}

export function createNestCat({ scene, floor, closePanels, onChange }) {
  const behavior = createCatBehavior({
    read(key) { try { return globalThis.localStorage?.getItem(key); } catch { return null; } },
    write(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch { /* 禁用存储时仍保留本次心情。 */ } }
  });
  const patch = mediaNode('img', 'ws-nest-cat-patch');
  patch.alt = '';
  patch.hidden = true;
  floor.append(patch);
  const panel = mediaNode('section', 'ws-nest-cat-panel');
  panel.dataset.nestPanel = 'cat';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '地毯上的橘猫');
  panel.hidden = true;
  const header = mediaNode('header', '');
  const dismiss = choice('close', '×');
  dismiss.setAttribute('aria-label', '关闭橘猫互动');
  header.append(mediaNode('h3', '', '地毯上的橘猫'), dismiss);
  const caption = mediaNode('strong', '');
  caption.setAttribute('role', 'status');
  const description = mediaNode('p', '');
  const actions = mediaNode('div', 'ws-nest-cat-actions');
  const main = choice('main', ''), leave = choice('leave', '');
  actions.append(main, leave);
  panel.append(header, caption, description, actions);
  scene.append(panel);

  let visible = false, busy = false, dark = false, allowVisit = true, lastActivity = '';
  let opener, timer, timerAt = 0, lastPatch, lastState;

  function clearTimer() {
    clearTimeout(timer);
    timerAt = 0;
  }

  function update() {
    const now = new Date();
    behavior.advance(now);
    if (visible && !document.hidden && !busy && allowVisit && lastActivity === 'cat-visit') behavior.visitOnce(now);
    const cat = behavior.snapshot(now);
    const [label, detail, command, secondary] = copy[cat.state];
    const image = patches[cat.state]?.[dark ? 1 : 0];
    if (lastPatch !== image) {
      lastPatch = image;
      patch.hidden = !image;
      if (image) patch.src = image;
    }
    scene.dataset.catState = cat.state;
    patch.dataset.pose = cat.state;
    if (lastState !== cat.state) {
      lastState = cat.state;
      caption.textContent = label;
      description.textContent = detail;
      main.textContent = command;
      if (!command && document.activeElement === main) leave.focus({ preventScroll: true });
      main.hidden = !command;
      leave.textContent = secondary;
    }
    if (visible && !document.hidden && timerAt !== cat.nextAt) {
      clearTimer();
      timerAt = cat.nextAt;
      timer = setTimeout(changed, Math.max(1, timerAt - now.getTime()));
    }
    return { state: cat.state, label, withCat: cat.withCat, activityLabel: cat.state === 'pet' ? '未央在地毯上轻挠橘猫的下巴' : label };
  }

  function changed() {
    update();
    onChange?.();
  }

  function hidePanel(restoreFocus) {
    panel.hidden = true;
    document.removeEventListener('keydown', escape, true);
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  function close(restoreFocus = false) {
    const changedPose = behavior.snapshot(new Date()).withCat;
    behavior.leave(new Date());
    hidePanel(restoreFocus);
    if (changedPose) changed();
    else update();
  }

  function escape(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  function open(trigger) {
    if (busy || !visible || document.hidden) return;
    closePanels?.('cat');
    opener = trigger;
    panel.hidden = false;
    update();
    document.addEventListener('keydown', escape, true);
    (main.hidden ? leave : main).focus({ preventScroll: true });
  }

  function render(lifeState, working, options = {}) {
    // 用户也可能通过聊天给房间下指令；自动陪猫同样应当立即让出姿态。
    const leftCatRoutine = lastActivity === 'cat-visit' && lifeState.activity !== lastActivity;
    const choseActivity = lifeState.manual && lastActivity && lifeState.activity !== lastActivity;
    if (choseActivity || (leftCatRoutine && panel.hidden)) {
      behavior.leave(new Date());
      if (!panel.hidden) hidePanel(false);
    }
    lastActivity = lifeState.activity;
    busy = working;
    dark = options.dark ?? (!lifeState.lampOn && lifeState.night);
    allowVisit = options.allowVisit !== false;
    if (busy || (!allowVisit && panel.hidden)) {
      behavior.leave(new Date());
      if (!panel.hidden) hidePanel(false);
    }
    return update();
  }

  function syncVisibility() {
    clearTimer();
    if (!visible || document.hidden) {
      behavior.leave(new Date());
      hidePanel(false);
    } else {
      behavior.resume(new Date());
      changed();
    }
  }

  function setVisible(on) {
    if (visible === on) return;
    visible = on;
    if (on) document.addEventListener('visibilitychange', syncVisibility);
    else document.removeEventListener('visibilitychange', syncVisibility);
    syncVisibility();
  }

  main.onclick = () => { behavior.interact(new Date()); changed(); };
  leave.onclick = dismiss.onclick = () => close(true);
  return { render, open, close, isOpen: () => !panel.hidden, setVisible, dispose: () => setVisible(false) };
}
