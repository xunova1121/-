import { createNestCat } from './nestCat.js';
import { createNestClock } from './nestClock.js';
import { createNestDesk } from './nestDesk.js';
import { createNestLiving } from './nestLiving.js';
import { createNestWindow } from './nestWindow.js';
import { createNestPhoto } from './nestPhoto.js';
import { createNestSofa } from './nestSofa.js';
import { nestArt, nestFigure, nestIsDark, nestNeedsSprite, nestFurniture, nestMobileSprites, nestSeatArt } from './nestArt.js';
import { MOBILE } from '../config.js';
import { createNestPanel } from './nestPanel.js';
import './nestStage.css';
import './nestMobile.css';

export function createNestStage({scene, floor, room, caption, deskHost, onChange, nestDeskOptions}) {
  const art = document.createElement('img');
  art.className = 'ws-nest-art';
  art.alt = '';
  art.draggable = false;
  art.decoding = 'async';
  if (MOBILE) {
    art.fetchPriority = 'high';
    for (const [name, url] of Object.entries(nestMobileSprites)) {
      document.documentElement.style.setProperty('--nest-mobile-' + name, 'url("' + url + '")');
    }
  }
  // 透出同一机位的空座位，让正在吃饭、唱歌、取档的旧动作也能在小窝中演出。
  const seat = document.createElement('img');
  seat.className = 'ws-nest-seat';
  seat.alt = '';
  seat.hidden = true;
  seat.draggable = false;
  const loveseat = document.createElement('div');
  loveseat.className = 'ws-nest-loveseat';
  loveseat.setAttribute('aria-hidden', 'true');
  floor.prepend(art, seat, loveseat);
  const sofa = createNestSofa(floor, scene);
  const clock = createNestClock(floor, art);
  const panel = createNestPanel(scene, caption, () => {
    desk.close(false);
    cat.close();
  }, () => desk.isOpen() || Boolean(scene.querySelector('.ws-media-panel:not([hidden])')));
  const desk = createNestDesk({scene, deskHost, ...nestDeskOptions, perform: room.perform});
  const cat = createNestCat({scene, floor, onChange, closePanels: closeExceptCat});
  const sash = createNestWindow({world: floor, panel, art});
  const photo = createNestPhoto({world: floor, panel});
  const controls = floor.querySelector('.ws-furniture-controls');
  const living = createNestLiving(floor);
  let active = false;
  let visible = false;
  let lastPose = '';
  let lastDark;
  let lastViewing = '';
  for (const [kind, label] of nestFurniture) {
    if (kind === 'trip') continue; // 手账可从草稿本及房间互动进入。
    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'ws-nest-hit';
    hit.dataset.furniture = kind;
    hit.setAttribute('aria-label', label);
    if (kind === 'folder' || kind === 'draft') hit.setAttribute('aria-haspopup','dialog');
    hit.onclick = () => open(kind, hit);
    controls.append(hit);
  }
  const catHit = controls.querySelector('[data-furniture="cat"]');
  function closeExceptCat() {
    panel.close(false);
    desk.close(false);
    scene.dispatchEvent(new Event('workshop:close-media'));
  }
  function closePanels(restoreFocus = false) {
    const hadCat = cat.isOpen();
    if (hadCat) cat.close(restoreFocus);
    const hadDesk = desk.close(restoreFocus);
    const hadPanel = panel.close(restoreFocus);
    return hadCat || hadDesk || hadPanel;
  }
  function open(kind, trigger) {
    if (!active) return;
    if (kind === 'cat') return cat.open();
    closePanels(false);
    scene.dispatchEvent(new Event('workshop:close-media'));
    if (kind === 'window') sash.open(trigger);
    else if (kind === 'photo') photo.open(trigger);
    else desk.open(kind, trigger);
    onChange();
  }
  function syncVisibility() {
    const shown = active && visible;
    clock.setVisible(shown);
    living.setVisible(shown);
    cat.setVisible(shown);
    sash.setVisible(shown);
    photo.setVisible(shown);
    desk.setVisible(shown);
    if (!shown) {
      sofa.settle();
      lastPose = '';
      closePanels();
    }
  }
  scene.addEventListener('workshop:media-opening', () => closePanels());
  scene.addEventListener('workshop:nest-open', e => open(e.detail.kind, e.detail.trigger));
  scene.addEventListener('workshop:nest-interrupt', () => {
    cat.close();
    closePanels();
  });
  scene.addEventListener('workshop:nest-panel-closed', onChange);
  function setActive(value) {
    if (active === value) return;
    active = value;
    scene.dataset.roomView = value ? 'nest' : 'floor';
    syncVisibility();
  }
  setActive(true);
  return {
    setActive,
    setVisible(on) { visible = on; syncVisibility(); },
    close: closePanels,
    render(state, {busy, station, operation}) {
      if (!active || !visible) return null;
      const dark = nestIsDark(state);
      const catState = cat.render(state, busy, {dark, allowVisit: cat.isOpen() || !panel.isOpen()});
      catHit.disabled = busy;
      const catHint = '橘猫 · ' + catState.label;
      if (catHit.getAttribute('aria-label') !== catHint) catHit.setAttribute('aria-label', catHint);
      const pose = nestFigure(state.activity, station, catState.withCat, busy, operation);
      const viewing = !busy && (pose === 'tv' || pose === 'news' && state.activity === 'news') ? pose : '';
      if (pose !== lastPose || dark !== lastDark || viewing !== lastViewing) {
        const sprite = nestNeedsSprite(pose);
        const url = nestArt(viewing ? 'work' : pose, dark, MOBILE);
        if (art.getAttribute('src') !== url) art.src = url;
        seat.hidden = !sprite && !viewing;
        if (!seat.hidden) {
          const emptySeat = MOBILE ? nestSeatArt(dark) : nestArt('sleep', dark);
          if (seat.getAttribute('src') !== emptySeat) seat.src = emptySeat;
        }
        if (viewing) {
          scene.dataset.nestViewing = viewing;
          scene.style.setProperty('--nest-view-art', 'url("' + url + '")');
        } else {
          delete scene.dataset.nestViewing;
          scene.style.removeProperty('--nest-view-art');
        }
        scene.dataset.nestPose = pose;
        scene.dataset.nestLight = dark ? 'off' : 'on';
        scene.toggleAttribute('data-nest-sprite', sprite && pose !== 'rest' && pose !== 'think');
        if (pose !== lastPose) sofa.enter(pose, lastPose, Boolean(lastViewing));
        floor.classList.toggle('night', dark);
        lastPose = pose;
        lastDark = dark;
        lastViewing = viewing;
      }
      living.render(viewing ? '' : pose, state, art.getAttribute('src'));
      sash.render({lampOn: !dark});
      photo.render({lampOn: !dark});
      desk.render(state, busy);
      if (catState.withCat) return catState.activityLabel;
      if (viewing === 'news') return '正在小沙发上读新闻';
      return !busy && state.activity === 'cat-visit' ? '未央在沙发上歇着看电视，橘猫想自己待一会儿' : null;
    }
  };
}
