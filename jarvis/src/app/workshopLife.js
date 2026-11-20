const MINUTE = 60000;
const STORAGE_KEY = 'jarvis.workshopLife.v1';
const activities = {
  coffee: { label: '正在泡咖啡', minutes: 5 },
  eat: { label: '正在吃饭', minutes: 20 },
  rest: { label: '坐下来歇一会儿', minutes: 10 },
  sleep: { label: '睡着了', minutes: 25 },
  tv: { label: '正在看电视', minutes: 15 },
  think: { label: '安静地想事情', minutes: 8 },
  sing: { label: '正在哼歌', minutes: 3 },
  shred: { label: '正在把桌上的废纸放进碎纸机', minutes: 0.25 }
};

// 起止时刻均按设备当地时间。未打开工作台时，下次直接按当前时间入场。
const routine = [
  [0, 'sleep'],
  [390, 'rest', '刚起床，伸个懒腰'],
  [420, 'eat', '正在吃早饭'],
  [450, 'coffee'],
  [458, 'quiet'],
  [720, 'eat', '正在吃午饭'],
  [750, 'rest', '吃过午饭，坐会儿'],
  [780, 'sleep', '正在午睡'],
  [805, 'quiet'],
  [900, 'coffee'],
  [908, 'quiet'],
  [1080, 'eat', '正在吃晚饭'],
  [1110, 'rest'],
  [1140, 'tv'],
  [1175, 'sing'],
  [1178, 'quiet'],
  [1230, 'tv'],
  [1275, 'rest'],
  [1310, 'think', '安静地回想今天的事'],
  [1350, 'sleep']
];

function routineAt(date) {
  const minute = date.getHours() * 60 + date.getMinutes();
  let period = routine[0];
  for (const entry of routine) {
    if (entry[0] > minute) break;
    period = entry;
  }
  const [start, activity, label] = period;
  if (activity !== 'quiet') return { activity, label: label ?? activities[activity].label };
  // 同一天重复进出房间时保持连贯，不会每次打开就换动作。
  const slot = (Math.floor((minute - start) / 22) + date.getDate()) % 3;
  if (slot === 0) return { activity: 'rest', label: '坐下来歇一会儿' };
  return { activity: 'think', label: slot === 1 ? '正望着窗外发呆' : '正在琢磨一个点子' };
}

let preferences = { lightMode: 'auto' };
let previousRaw = null;
const listeners = new Set();

function readPreferences() {
  // 保留内存值供禁用存储的 WebView 使用，也能在切回时读取其他页面更新的设置。
  try {
    const storage = globalThis.localStorage;
    if (!storage) return preferences;
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === previousRaw) return preferences;
    previousRaw = raw;
    preferences = { lightMode: 'auto' };
    const value = JSON.parse(raw);
    if (value?.lightMode === 'on' || value?.lightMode === 'off') preferences.lightMode = value.lightMode;
    if (typeof value?.action === 'string' && Object.hasOwn(activities, value.action) && Number.isFinite(value.startedAt)) {
      preferences.action = value.action;
      preferences.startedAt = value.startedAt;
    }
  } catch {
    // 无存储权限或旧记录损坏仍可进房间。
  }
  return preferences;
}

function manualEnd(prefs) {
  return prefs.action ? prefs.startedAt + activities[prefs.action].minutes * MINUTE : 0;
}

function stateAt(now, busy, prefs) {
  const date = new Date(now);
  const night = date.getHours() < 7 || date.getHours() >= 18;
  const manual = !busy && now >= prefs.startedAt && now < manualEnd(prefs);
  let state;
  if (busy) state = { activity: 'work', label: '正在工作' };
  else if (manual) state = { activity: prefs.action, label: activities[prefs.action].label };
  else state = routineAt(date);
  const lampOn = prefs.lightMode === 'auto' ? night && state.activity !== 'sleep' : prefs.lightMode === 'on';
  return { ...state, manual, night, lightMode: prefs.lightMode, lampOn };
}

export function getWorkshopLife({ busy = false } = {}) {
  return stateAt(Date.now(), busy, readPreferences());
}

// 只接收房间指令：碎纸仅处理画面中的废纸，不引用或修改真实文件空间。
export function dispatchWorkshopCommand(command, { busy = false } = {}) {
  const current = readPreferences();
  let next;
  if (command === 'lamp-on' || command === 'lamp-off' || command === 'lamp-auto') next = { ...current, lightMode: command.slice(5) };
  else if (command === 'auto') next = { lightMode: current.lightMode };
  else if (!busy && typeof command === 'string' && Object.hasOwn(activities, command)) next = { ...current, action: command, startedAt: Date.now() };
  else return false;

  preferences = next;
  try {
    const raw = JSON.stringify(next);
    globalThis.localStorage?.setItem(STORAGE_KEY, raw);
    previousRaw = raw;
  } catch {
    // 本次打开期间仍保存灯和正在做的动作。
  }
  listeners.forEach((notify) => notify());
  return true;
}

export function createWorkshopLife({ onChange = () => {} } = {}) {
  let visible = false;
  let busy = false;
  let previous;
  let timer;

  function refresh() {
    clearTimeout(timer);
    if (!visible || globalThis.document?.hidden) return;
    const now = Date.now();
    const prefs = readPreferences();
    const next = stateAt(now, busy, prefs);
    const toMinute = MINUTE - (now % MINUTE);
    const delay = next.manual ? Math.min(toMinute, manualEnd(prefs) - now) : toMinute;
    timer = setTimeout(refresh, delay);
    if (previous && Object.keys(next).every((key) => next[key] === previous[key])) return;
    previous = next;
    onChange(next);
  }

  function stored(event) {
    if (event.key === STORAGE_KEY || event.key === null) refresh();
  }

  function setVisible(value) {
    if (visible === value) return;
    visible = value;
    if (visible) {
      listeners.add(refresh);
      globalThis.window?.addEventListener('storage', stored);
      globalThis.document?.addEventListener('visibilitychange', refresh);
      refresh();
    } else {
      listeners.delete(refresh);
      globalThis.window?.removeEventListener('storage', stored);
      globalThis.document?.removeEventListener('visibilitychange', refresh);
      clearTimeout(timer);
    }
  }

  return {
    snapshot: () => getWorkshopLife({ busy }),
    perform: (command) => dispatchWorkshopCommand(command, { busy }),
    setVisible,
    setBusy(value) {
      if (busy === value) return;
      busy = value;
      refresh();
    },
    dispose: () => setVisible(false)
  };
}
