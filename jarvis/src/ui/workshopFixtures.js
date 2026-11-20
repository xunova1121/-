import './workshopFixtures.css';

// 这些道具与底图中的柜格、图纸和显示器共用坐标；状态和文件名由画面下方的真实记录提供。
export function addWorkshopFixtures(floorplan) {
  const fixtures = document.createElement('div');
  fixtures.className = 'ws-fixtures';
  fixtures.setAttribute('aria-hidden', 'true');
  function part(className, parent = fixtures) {
    const el = document.createElement('span');
    el.className = className;
    parent.append(el);
    return el;
  }

  part('ws-rack-folder');
  part('ws-drawing-slip');
  part('ws-pen-mark');
  const keyboard = part('ws-keyboard');
  for (const count of [9, 9, 7]) {
    const row = part('ws-key-row', keyboard);
    for (let i = 0; i < count; i++) part('ws-key', row);
  }
  const screen = part('ws-terminal-output');
  part('ws-terminal-caret', screen);
  floorplan.prepend(fixtures);
}
