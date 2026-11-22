import { createNestCat } from './nestCat.js';
import { createNestClock } from './nestClock.js';
import { createNestDesk } from './nestDesk.js';
import { createNestLiving } from './nestLiving.js';
import { createNestFramePacing } from './nestFramePacing.js';
import { createNestWindow } from './nestWindow.js';
import { createNestPhoto } from './nestPhoto.js';
import { createNestSofa } from './nestSofa.js';
import { nestArt, nestFigure, nestIsDark, nestNeedsSprite, nestFurniture, nestMobileSprites, nestSeatArt } from './nestArt.js';
import { MOBILE } from '../config.js';
import { createNestPanel } from './nestPanel.js';
import './nestStage.css';
import './nestMobile.css';
import './nestPortrait.css';
import frontSleeper from './assets/nestRoom/portrait/sleep.webp';
import { createNestPortrait, portraitArt } from './nestPortrait.js';

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
  const portrait = createNestPortrait(floor);
  const landscapeScreen = matchMedia('(min-width: 600px) and (min-aspect-ratio: 1.25)');
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
  const framePacing = createNestFramePacing(scene);
  let active = false;
  let visible = false;
  let upright = false;
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
  function layoutChanged() {
    const next = Boolean(scene.closest('.mobile-studio-sheet')) && !landscapeScreen.matches;
    if (scene.dataset.nestLayout === (next ? 'portrait' : 'landscape')) return;
    upright = next;
    scene.dataset.nestLayout = next ? 'portrait' : 'landscape';
    if (!next) portrait.hide();
    sofa.settle();
    lastPose = '';
    if (active && visible) onChange();
  }
  function syncVisibility() {
    const shown = active && visible;
    if (shown) {
      layoutChanged();
      landscapeScreen.addEventListener('change', layoutChanged);
    } else landscapeScreen.removeEventListener('change', layoutChanged);
    clock.setVisible(shown);
    living.setVisible(shown);
    cat.setVisible(shown);
    sash.setVisible(shown);
    photo.setVisible(shown);
    desk.setVisible(shown);
    if (!shown) {
      framePacing.stop();
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
    if (!value) {
      delete scene.dataset.nestLayout;
      portrait.hide();
    }
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
      if (upright) portrait.draw(pose, viewing, catState.state);
      if (pose !== lastPose || dark !== lastDark || viewing !== lastViewing) {
        framePacing.sample();
        const sprite = nestNeedsSprite(pose);
        const sleepInFront = !upright && pose === 'sleep';
        const url = upright ? portraitArt(dark ? 'room-off' : 'room-lit') : nestArt(viewing || sleepInFront ? 'work' : pose, dark, MOBILE);
        if (art.getAttribute('src') !== url) {
          art.src = url;
          if (upright) {
            const light = dark ? 'off' : 'lit';
            floor.style.setProperty('--nest-ceiling', 'url("' + portraitArt('ceiling-' + light) + '")');
            floor.style.setProperty('--nest-floor', 'url("' + portraitArt('floor-' + light) + '")');
          }
        }
        // 横幅的桌边人物已画在背景里。回桌途中先盖上原画空椅，抵达再露出手和纸张。
        const deskArrival = !upright && !viewing && ['work','news','trip'].includes(pose) && Boolean(lastPose);
        seat.toggleAttribute('data-walk-only', deskArrival);
        seat.hidden = upright || (!sprite && !viewing && !sleepInFront && !deskArrival);
        if (!seat.hidden) {
          const emptySeat = nestSeatArt(dark);
          if (seat.getAttribute('src') !== emptySeat) seat.src = emptySeat;
        }
        if (viewing) scene.dataset.nestViewing = viewing;
        else delete scene.dataset.nestViewing;
        scene.dataset.nestPose = pose;
        scene.dataset.nestLight = dark ? 'off' : 'on';
        scene.toggleAttribute('data-nest-sprite', sprite && pose !== 'rest' && pose !== 'think');
        if (pose !== lastPose || viewing !== lastViewing) {
          sofa.enter(pose, lastPose, Boolean(lastViewing), {upright, viewing});
        }
        floor.classList.toggle('night', dark);
        lastPose = pose;
        lastDark = dark;
        lastViewing = viewing;
      }
      living.render(viewing || (upright && pose !== 'coffee') ? '' : pose, state, art.getAttribute('src'),
        !upright && pose === 'sleep' ? frontSleeper : '');
      sash.render({lampOn: !dark, portrait: upright});
      photo.render({lampOn: !dark});
      desk.render(state, busy);
      if (catState.withCat) return catState.activityLabel;
      if (viewing === 'news') return '正在小沙发上读新闻';
      return !busy && state.activity === 'cat-visit' ? '未央在沙发上歇着看电视，橘猫想自己待一会儿' : null;
    }
  };
}
