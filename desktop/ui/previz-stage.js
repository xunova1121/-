/** 预演台纯数据层：不依赖 DOM，桌面、手机和测试共用。 */
const PREFIX = { camera: 'cam', subject: 'actor', prop: 'prop', light: 'light' };

function slug(value = '') {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

export function stableId(kind, item = {}, used = new Set()) {
  if (item.id && !used.has(item.id)) return item.id;
  const base = `${PREFIX[kind] || kind}-${slug(item.name) || 'item'}`;
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

/** 给旧项目无损补齐对象字段。重复调用不会改变已有 ID。 */
export function normalizeStage(stage = {}) {
  stage.cam ||= { x: 0, y: -3, height: 1.6, lens: 35, move: {} };
  stage.subjects ||= [];
  stage.marks ||= [];
  stage.lights ||= [];
  stage.keyframes ||= [];
  stage.motionEasing = ['linear', 'easeInOut', 'easeIn', 'easeOut'].includes(stage.motionEasing) ? stage.motionEasing : 'easeInOut';
  const used = new Set();
  const normalize = (kind, item, defaults = {}) => {
    for (const [key, value] of Object.entries(defaults)) {
      if (item[key] === undefined || item[key] === null) item[key] = value;
    }
    item.id = stableId(kind, item, used);
    used.add(item.id);
    item.rotation = Number(item.rotation ?? item.facing ?? 0);
    item.scale = Math.max(0.1, Number(item.scale || 1));
    item.locked = Boolean(item.locked);
    return item;
  };
  normalize('camera', stage.cam, {
    name: '摄影机', x: 0, y: -3, height: 1.6, aperture: 4, focusId: '',
    focusDistance: 3, shutterAngle: 180, iso: 400
  });
  stage.cam.aperture = Math.max(1, Math.min(22, Number(stage.cam.aperture || 4)));
  stage.cam.focusId = String(stage.cam.focusId || '');
  stage.cam.focusDistance = Math.max(.1, Math.min(100, Number(stage.cam.focusDistance || 3)));
  stage.cam.shutterAngle = Math.max(1, Math.min(360, Number(stage.cam.shutterAngle || 180)));
  stage.cam.iso = Math.max(25, Math.min(12800, Number(stage.cam.iso || 400)));
  stage.subjects.forEach((x) => {
    normalize('subject', x, { x: 0, y: 0, height: 1.72, pose: 'stand', action: '', animationName: '', autoOrient: true });
    x.pose = ['stand', 'walk', 'run', 'sit', 'crouch', 'reach', 'fight'].includes(x.pose) ? x.pose : 'stand';
    x.action = String(x.action || '');
    x.animationName = String(x.animationName || '');
    x.autoOrient = x.autoOrient !== false;
  });
  stage.marks.filter((x) => !x.far).forEach((x) => normalize('prop', x, { x: 0, y: 0, height: 0.9, width: 0.9 }));
  stage.lights.forEach((x) => {
    normalize('light', x, { name: '灯光', x: 0, y: -1, height: 2.6, lightType: 'spot', intensity: 2.5, color: '#ffd6a3', targetId: '' });
    x.lightType = ['spot', 'point', 'directional'].includes(x.lightType) ? x.lightType : 'spot';
    x.intensity = Math.max(0, Math.min(20, Number(x.intensity || 0)));
    x.color = /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#ffd6a3';
    x.targetId = String(x.targetId || '');
  });
  stage.schemaVersion = Math.max(3, Number(stage.schemaVersion || 0));
  return stage;
}

export function stageObjects(stage = {}) {
  normalizeStage(stage);
  return [
    { kind: 'camera', item: stage.cam },
    ...stage.subjects.map((item) => ({ kind: 'subject', item })),
    ...stage.marks.filter((item) => !item.far).map((item) => ({ kind: 'prop', item })),
    ...stage.lights.map((item) => ({ kind: 'light', item }))
  ];
}

export function findObject(stage, id) {
  return stageObjects(stage).find((x) => x.item.id === id) || null;
}

export function snapshot(stage) { return JSON.stringify(normalizeStage(stage)); }

export function restore(stage, serialized) {
  const next = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  for (const key of Object.keys(stage)) delete stage[key];
  Object.assign(stage, structuredClone(next));
  return normalizeStage(stage);
}

/** 一次拖动只生成一条历史，不会 pointermove 一百次就塞一百条。 */
export function createHistory(stage, { limit = 60 } = {}) {
  let current = snapshot(stage);
  const undo = [], redo = [];
  return {
    commit() {
      const next = snapshot(stage);
      if (next === current) return false;
      undo.push(current);
      if (undo.length > limit) undo.shift();
      current = next;
      redo.length = 0;
      return true;
    },
    undo() {
      if (!undo.length) return false;
      redo.push(current); current = undo.pop(); restore(stage, current); return true;
    },
    redo() {
      if (!redo.length) return false;
      undo.push(current); current = redo.pop(); restore(stage, current); return true;
    },
    sync() { current = snapshot(stage); redo.length = 0; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; }
  };
}

export function addKeyframe(stage, frame, objectIds = []) {
  normalizeStage(stage);
  const ids = objectIds.length ? objectIds : stageObjects(stage).map((x) => x.item.id);
  const values = {};
  for (const id of ids) {
    const found = findObject(stage, id);
    if (!found) continue;
    const x = found.item;
    values[id] = {
      x: x.x, y: x.y, elevation: x.elevation, height: x.height,
      rotation: x.rotation, rotationX: x.rotationX, rotationZ: x.rotationZ,
      scale: x.scale, scaleX: x.scaleX, scaleY: x.scaleY, scaleZ: x.scaleZ
    };
    if (found.kind === 'camera') {
      values[id].lens = x.lens;
      values[id].move = { ...(x.move || {}) };
      values[id].aperture = x.aperture;
      values[id].focusId = x.focusId || '';
      values[id].focusDistance = x.focusDistance;
      values[id].shutterAngle = x.shutterAngle;
      values[id].iso = x.iso;
    } else if (found.kind === 'subject') {
      values[id].pose = x.pose || 'stand';
      values[id].action = x.action || '';
      values[id].animationName = x.animationName || '';
      values[id].textureView = x.textureView || 'auto';
      values[id].textureGrid = x.textureGrid || 'horizontal';
      values[id].textureInset = x.textureInset || 0;
      values[id].autoOrient = x.autoOrient !== false;
    } else if (found.kind === 'light') {
      values[id].lightType = x.lightType;
      values[id].intensity = x.intensity;
      values[id].color = x.color;
      values[id].targetId = x.targetId || '';
    }
  }
  const key = { id: `kf-${Math.max(0, Math.round(frame))}`, frame: Math.max(0, Math.round(frame)), values };
  const at = stage.keyframes.findIndex((x) => x.frame === key.frame);
  if (at >= 0) stage.keyframes[at] = key; else stage.keyframes.push(key);
  stage.keyframes.sort((a, b) => a.frame - b.frame);
  return key;
}

/** 在两个关键帧之间线性求值，供时间轴预览和控制图序列共用。 */
export function frameState(stage, frame) {
  normalizeStage(stage);
  const keys = (stage.keyframes || []).slice().sort((a, b) => a.frame - b.frame);
  const f = Math.max(0, Number(frame) || 0);
  const left = [...keys].reverse().find((x) => x.frame <= f) || keys[0];
  const right = keys.find((x) => x.frame >= f) || keys.at(-1);
  const span = Math.max(1, Number(right?.frame || 0) - Number(left?.frame || 0));
  const rawT = left && right ? Math.max(0, Math.min(1, (f - left.frame) / span)) : 0;
  const t = stage.motionEasing === 'easeInOut' ? rawT * rawT * (3 - 2 * rawT)
    : stage.motionEasing === 'easeIn' ? rawT * rawT
      : stage.motionEasing === 'easeOut' ? 1 - (1 - rawT) * (1 - rawT) : rawT;
  const values = {};
  for (const { item } of stageObjects(stage)) {
    const a = left?.values?.[item.id] || item;
    const b = right?.values?.[item.id] || a;
    const out = { ...item };
    for (const key of ['x', 'y', 'elevation', 'height', 'rotation', 'rotationX', 'rotationZ', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'textureInset', 'lens', 'aperture', 'focusDistance', 'shutterAngle', 'iso', 'intensity']) {
      const av = Number(a[key]), bv = Number(b[key]);
      if (Number.isFinite(av) && Number.isFinite(bv)) out[key] = Number((av + (bv - av) * t).toFixed(4));
    }
    out.move = { ...((t < .5 ? a.move : b.move) || item.move || {}) };
    for (const key of ['focusId', 'pose', 'action', 'animationName', 'textureView', 'textureGrid', 'autoOrient', 'lightType', 'color', 'targetId']) out[key] = (rawT < .5 ? a[key] : b[key]) ?? item[key];
    if (item.autoOrient !== false && stage.subjects.includes(item)) {
      const dx = Number(b.x || 0) - Number(a.x || 0), dy = Number(b.y || 0) - Number(a.y || 0);
      if (Math.hypot(dx, dy) > .001) out.rotation = Number((Math.atan2(dx, dy) * 180 / Math.PI).toFixed(4));
    }
    values[item.id] = out;
  }
  return { frame: f, left: left?.frame ?? null, right: right?.frame ?? null, t, rawT, values };
}

export function applyFrame(stage, frame) {
  const state = frameState(stage, frame);
  for (const { item } of stageObjects(stage)) Object.assign(item, state.values[item.id] || {});
  return state;
}

