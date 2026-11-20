import './workStudioView.css';
import './workbenchWorkshopMotion.css';
import { addWorkshopFixtures } from './workshopFixtures.js';
import { createWorkshopMotion, routineStations, stationForStep, stationNames } from './workshopMotion.js';
import { createWorkshopRoom } from './workshopRoom.js';

const poses = {
  idle: '安静等候', run: '跑去取资料', think: '托腮思考', edit: '动笔修改',
  stomp: '着急跺脚', repair: '动手调整', cheer: '举手庆祝', stop: '停下等候'
};
const statuses = { running: '进行中', done: '已完成', error: '出错了', stopped: '已停止', waiting: '等待中' };

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function control(action, label, text = label) {
  const button = node('button', 'ws-control', text);
  button.type = 'button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

// 只演真实记录里的动作；停止和错误优先于角色动画。
function eventPose(entry) {
  if (entry?.status === 'stopped') return 'stop';
  if (entry?.status === 'error') return 'stomp';
  return Object.hasOwn(poses, entry?.pose) ? entry.pose : 'idle';
}

function text(el, content = '') {
  if (el.textContent !== content) el.textContent = content;
}

export function createWorkStudioView({ workshop = false } = {}) {
  const element = node('section', 'work-studio work-studio-view');
  const viewTitle = workshop ? '未央工作台' : '看未央工作';
  element.setAttribute('aria-label', viewTitle);
  element.hidden = true;
  if (workshop) element.dataset.workshop = 'true';

  const header = node('div', 'ws-header');
  const heading = node('h2', 'ws-heading', viewTitle);
  const mode = node('span', 'ws-mode');
  const toolbar = node('div', 'ws-playback-controls');
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', '动作回放');
  const back = control('back', '上一步', '‹');
  const play = control('play', '回放');
  const next = control('forward', '下一步', '›');
  const follow = control('live', '回到实时');
  toolbar.append(back, play, next, follow);
  header.append(heading, mode, toolbar);

  const body = node('div', 'ws-body');
  const performance = node('div', 'ws-performance');
  const scene = node('div', 'ws-scene');
  const actor = node('div', 'ws-actor');
  actor.setAttribute('aria-hidden', 'true');
  actor.append(node('div', 'ws-sprite'));
  const prop = node('div', 'ws-prop');
  const propTitle = node('b', 'ws-prop-title');
  prop.append(node('span', 'ws-prop-mark'), propTitle, node('span', 'ws-prop-stroke'));
  // 文件对象也作为可选中文本呈现在下方；场景里只画一次。
  prop.setAttribute('aria-hidden', 'true');
  const chip = node('span', 'ws-pose-label');
  let motion, room;
  if (workshop) {
    const floor = node('div', 'ws-floorplan');
    addWorkshopFixtures(floor);
    floor.append(actor);
    scene.append(floor, chip, prop);
    motion = createWorkshopMotion(scene, actor);
    room = createWorkshopRoom(scene, floor, update);
  } else scene.append(chip, prop, actor);
  const caption = node('div', 'ws-caption');
  const action = node('strong', 'ws-action');
  const detail = node('span', 'ws-detail');
  const file = node('span', 'ws-file');
  const stationLabel = workshop ? node('span', 'ws-station-name') : null;
  if (stationLabel) caption.append(stationLabel);
  caption.append(action, detail, file);
  let zoom;
  function setZoom(detail) {
    element.dataset.zoom = detail ? 'detail' : 'wide';
    const label = detail ? '看全景' : '近看操作';
    zoom.textContent = label;
    zoom.setAttribute('aria-label', label);
    zoom.setAttribute('aria-pressed', String(detail));
    zoom.title = label;
  }
  if (workshop) {
    zoom = control('zoom', '近看操作');
    zoom.className = 'ws-zoom-toggle';
    setZoom(false);
    zoom.onclick = () => setZoom(element.dataset.zoom !== 'detail');
    caption.append(zoom);
  }
  performance.append(scene, caption);

  const timeline = node('aside', 'ws-timeline');
  const listHeader = node('div', 'ws-list-header');
  const count = node('span', 'ws-count');
  listHeader.append(node('h3', '', '任务记录'), count);
  const list = node('ol', 'ws-list');
  list.setAttribute('aria-label', '按时间排列的任务步骤');
  const empty = node('p', 'ws-empty', '任务开始后，这里会记录实际步骤。');
  timeline.append(listHeader, list, empty);
  body.append(performance, timeline);
  element.append(header, body);

  let snapshot = { sessionId: '', entries: [], active: false };
  let visible = false;
  let selected = null; // null 表示跟随最新步骤，回看时按稳定的事件 id 定位。
  let playing = false;
  let timer = null;
  let justFinished = null;
  const rows = new Map();

  function index() {
    const entries = snapshot.entries;
    return selected === null ? entries.length - 1 : entries.findIndex(entry => entry.id === selected);
  }

  function stopPlaying() {
    clearTimeout(timer);
    timer = null;
    playing = false;
    element.dataset.playing = 'false';
  }

  function tick() {
    timer = null;
    if (!visible || document.hidden || !playing) return;
    const n = index() + 1;
    if (n >= snapshot.entries.length) {
      stopPlaying();
    } else {
      selected = snapshot.entries[n].id;
      if (n === snapshot.entries.length - 1) stopPlaying();
    }
    update();
    revealSelection();
  }

  function updateScene(entry) {
    const pose = eventPose(entry);
    element.dataset.pose = pose;
    element.dataset.mode = selected === null ? 'live' : 'review';
    element.dataset.playing = String(playing);
    const isReview = selected !== null;
    text(mode, isReview ? '回看' : snapshot.active ? '实时' : entry ? '本次任务' : '待命');
    text(chip, poses[pose]);
    const title = entry?.title || (snapshot.active ? '等待任务进度' : '等待新任务');
    text(action, title);
    // 后端给的是脱敏显示名，不能拿它拼地址打开文件。
    const filename = entry?.file || '';
    const description = entry?.detail || '';
    text(detail, description);
    detail.hidden = !description || description === title || description === filename;
    detail.title = description;
    text(file, filename);
    file.hidden = !filename;
    file.title = filename;
    prop.hidden = !entry;
    text(propTitle, filename || title);
    prop.dataset.kind = filename ? 'file' : 'action';
    const n = index();
    if (motion) {
      const backgroundWork = !isReview && snapshot.otherWork && !snapshot.active;
      const showTask = Boolean(isReview || snapshot.active || backgroundWork || justFinished !== null);
      const state = room.render(showTask, !backgroundWork && entry?.roomOperation === 'shred' && entry.status === 'done');
      const routine = scene.dataset.lifePose === state.activity ? routineStations[state.activity] : null;
      const station = routine?.station || stationForStep(snapshot.entries, n);
      text(stationLabel, stationNames[station]);
      const live = !isReview && snapshot.active;
      const movingStep = !!entry && entry.status !== 'waiting' && entry.status !== 'stopped' && !['idle', 'stop', 'stomp', 'cheer'].includes(pose);
      motion.show(station, {
        entry: showTask ? entry : null, entries: snapshot.entries, mode: isReview ? (playing ? 'play' : 'manual') : 'live', active: snapshot.active,
        routineOperation: routine?.operation,
        travel: !!routine || (movingStep && (live || playing)),
        working: !!routine || (movingStep && ((live && entry.status === 'running') || playing)),
        gesture: showTask && !isReview && (pose === 'stomp' || pose === 'cheer')
      }, state.workOrigin);
      if (state.activity !== 'work') {
        text(mode, '生活中');
        text(stationLabel, routine ? stationNames[station] : '工作台');
        text(action, state.label);
        detail.hidden = file.hidden = prop.hidden = true;
      } else if (backgroundWork) {
        text(mode, '工作中');
        text(stationLabel, '工作台');
        text(action, '正在处理另一段对话的任务');
        detail.hidden = file.hidden = prop.hidden = true;
      }
    }
    back.disabled = n <= 0;
    next.disabled = n < 0 || n >= snapshot.entries.length - 1;
    play.disabled = snapshot.entries.length < 2;
    const playLabel = playing ? '暂停' : !isReview || n >= snapshot.entries.length - 1 ? '回放' : '播放';
    text(play, playLabel);
    play.title = playLabel;
    play.setAttribute('aria-label', playLabel);
    follow.hidden = !isReview;
  }

  // 事件开始与结束可以使用同一 id。只更新对应行，保留焦点和手工滚动的位置。
  function updateRows(entry) {
    const previous = new Set(rows.keys());
    const followVertical = selected === null && list.scrollHeight - list.clientHeight - list.scrollTop < 8;
    const followHorizontal = selected === null && list.scrollWidth - list.clientWidth - list.scrollLeft < 8;
    let before = list.firstElementChild;
    for (const event of snapshot.entries) {
      const id = event.id;
      previous.delete(id);
      let row = rows.get(id);
      if (!row) {
        const item = node('li');
        const button = node('button', 'ws-row');
        button.type = 'button';
        button.dataset.entryId = id;
        const thumb = node('span', 'ws-row-icon');
        thumb.setAttribute('aria-hidden', 'true');
        const title = node('span', 'ws-row-title');
        const state = node('small', 'ws-row-state');
        button.append(thumb, title, state);
        item.append(button);
        row = { item, button, title, state };
        rows.set(id, row);
      }
      if (row.item !== before) list.insertBefore(row.item, before);
      before = row.item.nextElementSibling;
      const isCurrent = id === entry?.id;
      const pose = eventPose(event);
      row.button.dataset.pose = pose;
      row.button.dataset.status = Object.hasOwn(statuses, event.status) ? event.status : '';
      if (isCurrent) row.button.setAttribute('aria-current', 'step');
      else row.button.removeAttribute('aria-current');
      text(row.title, event.title || poses[pose]);
      row.button.title = event.detail || event.title || '';
      text(row.state, statuses[row.button.dataset.status]);
    }
    for (const id of previous) {
      rows.get(id).item.remove();
      rows.delete(id);
    }
    text(count, snapshot.entries.length ? String(snapshot.entries.length) : '');
    empty.hidden = snapshot.entries.length > 0;
    if (followVertical) list.scrollTop = list.scrollHeight;
    if (followHorizontal) list.scrollLeft = list.scrollWidth;
  }

  function update() {
    if (!visible || document.hidden) return;
    const entry = snapshot.entries[index()];
    updateScene(entry);
    updateRows(entry);
    if (playing && timer === null) timer = setTimeout(tick, 1900);
  }

  function revealSelection() {
    const row = rows.get(snapshot.entries[index()]?.id);
    if (!row) return;
    const area = list.getBoundingClientRect();
    const rect = row.item.getBoundingClientRect();
    // 只调整步骤列表，不能把整页聊天和输入栏带着滚动。
    if (rect.left < area.left) list.scrollLeft += rect.left - area.left;
    else if (rect.right > area.right) list.scrollLeft += rect.right - area.right;
    if (rect.top < area.top) list.scrollTop += rect.top - area.top;
    else if (rect.bottom > area.bottom) list.scrollTop += rect.bottom - area.bottom;
  }

  function review(i) {
    if (i < 0 || i >= snapshot.entries.length) return;
    stopPlaying();
    selected = snapshot.entries[i].id;
    update();
    revealSelection();
  }

  back.onclick = () => review(index() - 1);
  next.onclick = () => review(index() + 1);
  follow.onclick = () => { stopPlaying(); selected = null; update(); revealSelection(); };
  play.onclick = () => {
    if (playing) { stopPlaying(); update(); return; }
    if (snapshot.entries.length < 2) return;
    if (selected === null || index() === snapshot.entries.length - 1) selected = snapshot.entries[0].id;
    playing = true;
    update();
    revealSelection();
  };
  list.onclick = event => {
    const row = event.target.closest?.('.ws-row');
    if (row && list.contains(row)) review(snapshot.entries.findIndex(item => item.id === row.dataset.entryId));
  };

  function visibilityChanged() {
    const shown = visible && !document.hidden;
    element.dataset.visible = String(shown);
    room?.setVisible(shown);
    if (!shown) { stopPlaying(); motion?.reset(); clearTimeout(justFinished); justFinished = null; }
    else update();
  }

  return {
    element,
    render(nextSnapshot) {
      if (nextSnapshot.sessionId !== snapshot.sessionId) {
        clearTimeout(justFinished);
        justFinished = null;
        stopPlaying();
        motion?.reset();
        if (zoom) setZoom(false);
        selected = null;
        for (const row of rows.values()) row.item.remove();
        rows.clear();
        list.scrollTop = 0;
      } else if (visible && !document.hidden && snapshot.active && !nextSnapshot.active) {
        // 工具完成后先留出辨认收尾动作的时间，再回到当前时刻的生活。
        clearTimeout(justFinished);
        justFinished = setTimeout(() => { justFinished = null; update(); }, 2300);
      }
      snapshot = nextSnapshot;
      if (selected !== null && index() < 0) {
        stopPlaying();
        selected = null;
      }
      update();
    },
    setVisible(on) {
      const show = Boolean(on);
      if (visible === show) return;
      visible = show;
      element.hidden = !show;
      if (show) document.addEventListener('visibilitychange', visibilityChanged);
      else document.removeEventListener('visibilitychange', visibilityChanged);
      visibilityChanged();
    }
  };
}
