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
  stage.pathInterpolation = ['linear', 'smooth'].includes(stage.pathInterpolation) ? stage.pathInterpolation : 'linear';
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
    normalize('subject', x, { x: 0, y: 0, height: 1.72, pose: 'stand', action: '', animationName: '', autoOrient: true, grounded: true });
    x.pose = ['stand', 'walk', 'run', 'sit', 'crouch', 'reach', 'fight'].includes(x.pose) ? x.pose : 'stand';
    x.action = String(x.action || '');
    x.animationName = String(x.animationName || '');
    x.autoOrient = x.autoOrient !== false;
    x.grounded = x.grounded !== false;
  });
  stage.marks.filter((x) => !x.far).forEach((x) => {
    normalize('prop', x, { x: 0, y: 0, height: 0.9, width: 0.9, attachToId: '', attachPoint: 'rightHand', attachOffsetX: 0, attachOffsetY: 0, attachOffsetZ: 0 });
    x.attachToId = String(x.attachToId || '');
    x.attachPoint = ['rightHand', 'leftHand', 'back', 'waist'].includes(x.attachPoint) ? x.attachPoint : 'rightHand';
    for (const key of ['attachOffsetX', 'attachOffsetY', 'attachOffsetZ']) x[key] = Number(x[key] || 0);
    x.grounded = x.grounded !== false;
  });
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

/** 把人物局部挂点换算成舞台世界坐标；渲染、控制图与提示词共用同一份结果。 */
export function attachmentPose(stage, item) {
  const actor = (stage?.subjects || []).find((x) => x.id === item?.attachToId);
  if (!actor) return null;
  const h = Math.max(.5, Number(actor.height || 1.72));
  const anchors = {
    rightHand: { x: h * .28, y: h * .61, z: 0 },
    leftHand: { x: -h * .28, y: h * .61, z: 0 },
    back: { x: 0, y: h * .64, z: h * .13 },
    waist: { x: h * .22, y: h * .48, z: h * .08 }
  };
  const anchor = anchors[item.attachPoint] || anchors.rightHand;
  const lx = anchor.x + Number(item.attachOffsetX || 0);
  const lz = anchor.z + Number(item.attachOffsetZ || 0);
  const rad = -Number(actor.rotation ?? actor.facing ?? 0) * Math.PI / 180;
  return {
    x: Number(actor.x || 0) + lx * Math.cos(rad) + lz * Math.sin(rad),
    y: Number(actor.y || 0) - lx * Math.sin(rad) + lz * Math.cos(rad),
    elevation: Number(actor.elevation || 0) + anchor.y + Number(item.attachOffsetY || 0),
    rotation: Number(actor.rotation ?? actor.facing ?? 0) + Number(item.rotation || 0), actor
  };
}

/**
 * 找离自由道具最近的可用挂点。只有在手边的道具才建议吸附，避免把
 * 房间另一头的剑一键“瞬移”到人物手上。返回结果可直接写回道具绑定字段。
 */
export function nearestAttachment(stage, item, { maxDistance = 1.4 } = {}) {
  normalizeStage(stage);
  if (!item || item.attachToId) return null;
  const pointNames = ['rightHand', 'leftHand'];
  let best = null;
  for (const actor of stage.subjects || []) {
    for (const attachPoint of pointNames) {
      const pose = attachmentPose(stage, { ...item, attachToId: actor.id, attachPoint });
      const distance = Math.hypot(Number(item.x || 0) - pose.x, Number(item.y || 0) - pose.y);
      if (!best || distance < best.distance) best = { actor, attachPoint, pose, distance };
    }
  }
  return best?.distance <= maxDistance ? best : null;
}

/** 解除人物挂点时，把道具留在解绑瞬间的世界坐标，避免回到旧坐标而瞬移。 */
export function detachAttachment(stage, item, { ground = true } = {}) {
  if (!item) return null;
  const pose = attachmentPose(stage, item);
  if (pose) {
    item.x = Number(Number(pose.x).toFixed(2));
    item.y = Number(Number(pose.y).toFixed(2));
    item.rotation = Number(Number(pose.rotation || 0).toFixed(1));
    item.elevation = ground ? 0 : Number(Number(pose.elevation || 0).toFixed(2));
  }
  item.attachToId = '';
  if (ground) item.grounded = true;
  return item;
}

export function snapToGround(item) {
  if (!item) return item;
  item.elevation = 0;
  item.grounded = true;
  return item;
}

/** 生成前的空间质检：脚底悬空/穿地、对象穿模、人物被另一人完全挡住。 */
export function spatialIssues(stage = {}) {
  normalizeStage(stage);
  const issues = [];
  const movable = [...(stage.subjects || []).map((item) => ({ kind: 'subject', item })),
    ...(stage.marks || []).filter((x) => !x.far && !x.attachToId).map((item) => ({ kind: 'prop', item }))];
  for (const { kind, item } of movable) {
    if (item.grounded === false) continue;
    const elevation = Number(item.elevation || 0);
    if (elevation < -.02) issues.push({ code: 'below-floor', objectId: item.id, level: 'blocker', message: `${item.name || item.id}穿进地面 ${Math.abs(elevation).toFixed(2)} 米` });
    else if (elevation > .06) issues.push({ code: 'floating-object', objectId: item.id, level: 'warn', message: `${item.name || item.id}脚底/底部悬空 ${elevation.toFixed(2)} 米` });
  }
  const colliders = movable.map(({ kind, item }) => ({ kind, item, x: Number(item.x || 0), y: Number(item.y || 0),
    radius: kind === 'subject' ? .26 * Number(item.scale || 1) : Math.max(.12, Number(item.width || .6) * Number(item.scale || 1) * .36) }));
  for (let i = 0; i < colliders.length; i += 1) for (let j = i + 1; j < colliders.length; j += 1) {
    const a = colliders[i], b = colliders[j], distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (distance < (a.radius + b.radius) * .62) issues.push({ code: 'object-overlap', objectIds: [a.item.id, b.item.id], level: 'warn', message: `${a.item.name || a.item.id}与${b.item.name || b.item.id}发生明显穿模` });
  }
  const cam = stage.cam || { x: 0, y: -3 };
  const subjects = (stage.subjects || []).map((item) => {
    const dx = Number(item.x || 0) - Number(cam.x || 0), dy = Number(item.y || 0) - Number(cam.y || 0);
    return { item, distance: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
  }).sort((a, b) => a.distance - b.distance);
  for (let i = 0; i < subjects.length; i += 1) for (let j = i + 1; j < subjects.length; j += 1) {
    const front = subjects[i], rear = subjects[j];
    const delta = Math.abs(Math.atan2(Math.sin(front.angle - rear.angle), Math.cos(front.angle - rear.angle))) * 180 / Math.PI;
    // 只有明确标成“有意前景遮挡”的人物才跳过提示；默认仍保持严格检查。
    if (rear.item.occlusionMode !== 'intentional' && rear.distance - front.distance > .55 && delta < 4.5) {
      issues.push({ code: 'subject-occluded', objectIds: [front.item.id, rear.item.id], level: 'warn', message: `${rear.item.name || rear.item.id}可能被${front.item.name || front.item.id}完全遮挡` });
    }
  }
  return issues;
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
    } else if (found.kind === 'prop') {
      values[id].attachToId = x.attachToId || '';
      values[id].attachPoint = x.attachPoint || 'rightHand';
      values[id].attachOffsetX = Number(x.attachOffsetX || 0);
      values[id].attachOffsetY = Number(x.attachOffsetY || 0);
      values[id].attachOffsetZ = Number(x.attachOffsetZ || 0);
      values[id].grounded = x.grounded !== false;
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

function eased(rawT, mode) {
  return mode === 'easeInOut' ? rawT * rawT * (3 - 2 * rawT)
    : mode === 'easeIn' ? rawT * rawT
      : mode === 'easeOut' ? 1 - (1 - rawT) * (1 - rawT) : rawT;
}

/** Catmull-Rom 曲线。端点重复，确保首尾严格落在关键帧上。 */
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return .5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function curveValue(track, index, id, key, t, fallback) {
  const read = (at, otherwise) => {
    const value = Number(track[Math.max(0, Math.min(track.length - 1, at))]?.values?.[id]?.[key]);
    return Number.isFinite(value) ? value : otherwise;
  };
  const p1 = read(index, Number(fallback) || 0);
  const p2 = read(index + 1, p1);
  const p0 = read(index - 1, p1);
  const p3 = read(index + 2, p2);
  return catmull(p0, p1, p2, p3, t);
}

/**
 * 按对象自己的关键帧轨道求值，供时间轴预览、真实 WebGL 逐帧和控制图共用。
 *
 * 不能拿“全场最近关键帧”给每个对象插值：摄影机在 24f 打了一帧，不代表人物
 * 也在 24f 打了帧。混用会让人物先朝当前舞台位置漂一下，再突然回到自己的轨迹。
 */
export function frameState(stage, frame) {
  normalizeStage(stage);
  const keys = (stage.keyframes || []).slice().sort((a, b) => a.frame - b.frame);
  const f = Math.max(0, Number(frame) || 0);
  const left = [...keys].reverse().find((x) => x.frame <= f) || keys[0];
  const right = keys.find((x) => x.frame >= f) || keys.at(-1);
  const span = Math.max(1, Number(right?.frame || 0) - Number(left?.frame || 0));
  const rawT = left && right ? Math.max(0, Math.min(1, (f - left.frame) / span)) : 0;
  const t = eased(rawT, stage.motionEasing);
  const values = {};
  for (const { item } of stageObjects(stage)) {
    const track = keys.filter((key) => key.values?.[item.id]);
    if (!track.length) { values[item.id] = { ...item }; continue; }
    let leftIndex = 0;
    for (let i = 0; i < track.length; i += 1) if (track[i].frame <= f) leftIndex = i;
    if (f < track[0].frame) leftIndex = 0;
    const rightIndex = f <= track[0].frame ? 0 : Math.min(track.length - 1, leftIndex + (track[leftIndex].frame < f ? 1 : 0));
    const objectLeft = track[leftIndex], objectRight = track[rightIndex];
    const objectSpan = Math.max(1, Number(objectRight.frame) - Number(objectLeft.frame));
    const objectRawT = leftIndex === rightIndex ? 0 : Math.max(0, Math.min(1, (f - objectLeft.frame) / objectSpan));
    const objectT = eased(objectRawT, stage.motionEasing);
    const a = objectLeft.values[item.id];
    const b = objectRight.values[item.id] || a;
    const out = { ...item };
    for (const key of ['x', 'y', 'elevation', 'height', 'rotation', 'rotationX', 'rotationZ', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'textureInset', 'lens', 'aperture', 'focusDistance', 'shutterAngle', 'iso', 'intensity', 'attachOffsetX', 'attachOffsetY', 'attachOffsetZ']) {
      const av = Number(a[key]), bv = Number(b[key]);
      if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
      const spatial = ['x', 'y', 'elevation', 'height'].includes(key);
      const value = stage.pathInterpolation === 'smooth' && spatial && leftIndex !== rightIndex
        ? curveValue(track, leftIndex, item.id, key, objectT, av)
        : av + (bv - av) * objectT;
      out[key] = Number(value.toFixed(4));
    }
    out.move = { ...((objectT < .5 ? a.move : b.move) || item.move || {}) };
    for (const key of ['focusId', 'pose', 'action', 'animationName', 'textureView', 'textureGrid', 'autoOrient', 'lightType', 'color', 'targetId', 'attachToId', 'attachPoint', 'grounded']) out[key] = (objectRawT < .5 ? a[key] : b[key]) ?? item[key];
    if (out.autoOrient !== false && stage.subjects.includes(item)) {
      let dx = Number(b.x || 0) - Number(a.x || 0), dy = Number(b.y || 0) - Number(a.y || 0);
      if (stage.pathInterpolation === 'smooth' && leftIndex !== rightIndex) {
        const before = Math.max(0, objectT - .01), after = Math.min(1, objectT + .01);
        dx = curveValue(track, leftIndex, item.id, 'x', after, a.x) - curveValue(track, leftIndex, item.id, 'x', before, a.x);
        dy = curveValue(track, leftIndex, item.id, 'y', after, a.y) - curveValue(track, leftIndex, item.id, 'y', before, a.y);
      }
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

