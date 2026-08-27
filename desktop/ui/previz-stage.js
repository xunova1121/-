/** 预演台纯数据层：不依赖 DOM，桌面、手机和测试共用。 */
const PREFIX = { camera: 'cam', subject: 'actor', prop: 'prop' };

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
  stage.keyframes ||= [];
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
  normalize('camera', stage.cam, { name: '摄影机', x: 0, y: -3, height: 1.6 });
  stage.subjects.forEach((x) => normalize('subject', x, { x: 0, y: 0, height: 1.72 }));
  stage.marks.filter((x) => !x.far).forEach((x) => normalize('prop', x, { x: 0, y: 0, height: 0.9, width: 0.9 }));
  stage.schemaVersion = Math.max(2, Number(stage.schemaVersion || 0));
  return stage;
}

export function stageObjects(stage = {}) {
  normalizeStage(stage);
  return [
    { kind: 'camera', item: stage.cam },
    ...stage.subjects.map((item) => ({ kind: 'subject', item })),
    ...stage.marks.filter((item) => !item.far).map((item) => ({ kind: 'prop', item }))
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
    values[id] = { x: x.x, y: x.y, height: x.height, rotation: x.rotation, scale: x.scale };
  }
  const key = { id: `kf-${Math.max(0, Math.round(frame))}`, frame: Math.max(0, Math.round(frame)), values };
  const at = stage.keyframes.findIndex((x) => x.frame === key.frame);
  if (at >= 0) stage.keyframes[at] = key; else stage.keyframes.push(key);
  stage.keyframes.sort((a, b) => a.frame - b.frame);
  return key;
}
