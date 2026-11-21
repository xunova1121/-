import { createNestCat } from './nestCat.js';
import { createNestDesk } from './nestDesk.js';
import { createNestWindow } from './nestWindow.js';
import { createNestPhoto } from './nestPhoto.js';
import { nestArt, nestFigure, nestIsDark, nestNeedsSprite, nestFurniture } from './nestArt.js';
import { createNestPanel } from './nestPanel.js';
import './nestStage.css';

export function createNestStage({scene, floor, room, onChange, nestDeskOptions}) {
  const art = document.createElement('img');
  art.className = 'ws-nest-art';
  art.alt = '';
  art.draggable = false;
  // 透出同一机位的空座位，让正在吃饭、唱歌、取档的旧动作也能在小窝中演出。
  const seat = document.createElement('img');
  seat.className = 'ws-nest-seat';
  seat.alt = '';
  seat.hidden = true;
  seat.draggable = false;
  floor.prepend(art, seat);
  const panel = createNestPanel(scene, () => {
    desk.close(false);
    cat.close();
  }, () => Boolean(scene.querySelector('.ws-media-panel:not([hidden]), [data-nest-desk]:not([hidden]), [data-nest-panel="cat"]:not([hidden])')));
  const desk = createNestDesk({scene, ...nestDeskOptions, perform: room.perform});
  const cat = createNestCat({scene, floor, onChange, closePanels: closeExceptCat});
  const sash = createNestWindow({world: floor, panel, art});
  const photo = createNestPhoto({world: floor, panel});
  const controls = floor.querySelector('.ws-furniture-controls');
  let active = false;
  let visible = false;
  let lastPose = '';
  let lastDark;
  for (const [kind, label] of nestFurniture) {
    if (kind === 'trip') continue; // 手账可从草稿本及房间互动进入。
    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'ws-nest-hit';
    hit.dataset.furniture = kind;
    hit.setAttribute('aria-label', label);
    hit.setAttribute('aria-haspopup','dialog');
    hit.title = label;
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
    closePanels(false);
    scene.dispatchEvent(new Event('workshop:close-media'));
    if (kind === 'cat') cat.open(trigger);
    else if (kind === 'window') sash.open(trigger);
    else if (kind === 'photo') photo.open(trigger);
    else desk.open(kind, trigger);
    onChange();
  }
  function syncVisibility() {
    const shown = active && visible;
    cat.setVisible(shown);
    sash.setVisible(shown);
    photo.setVisible(shown);
    desk.setVisible(shown);
    if (!shown) closePanels();
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
      if (catHit.title !== catHint) {
        catHit.title = catHint;
        catHit.setAttribute('aria-label', catHint);
      }
      const pose = nestFigure(state.activity, station, catState.withCat, busy, operation);
      if (pose !== lastPose || dark !== lastDark) {
        const sprite = nestNeedsSprite(pose);
        const url = nestArt(pose, dark);
        if (art.getAttribute('src') !== url) art.src = url;
        seat.hidden = !sprite;
        if (sprite) {
          const emptySeat = nestArt('tv', dark);
          if (seat.getAttribute('src') !== emptySeat) seat.src = emptySeat;
        }
        scene.dataset.nestPose = pose;
        scene.dataset.nestLight = dark ? 'off' : 'on';
        scene.toggleAttribute('data-nest-sprite', sprite);
        floor.classList.toggle('night', dark);
        lastPose = pose;
        lastDark = dark;
      }
      sash.render({lampOn: !dark});
      photo.render({lampOn: !dark});
      desk.render(state, busy);
      if (catState.withCat) return catState.activityLabel;
      return !busy && state.activity === 'cat-visit' ? '未央在沙发上歇着看电视，橘猫想自己待一会儿' : null;
    }
  };
}
