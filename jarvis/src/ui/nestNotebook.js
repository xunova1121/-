export const tripChecklist = ['查好交通', '安排住处', '整理行李'];
export const cityRoutes = new Map([
  ['杭州', ['湖滨', '柳浪闻莺', '南山路']],
  ['厦门', ['沙坡尾', '演武大桥', '白城沙滩']],
  ['成都', ['人民公园', '宽窄巷子', '琴台路']]
]);

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function defaultNestTrip(now = new Date()) {
  const saturday = new Date(now);
  saturday.setDate(saturday.getDate() + (6 - saturday.getDay() + 7) % 7);
  return { destination: '杭州', date: localDate(saturday), stops: '', checked: tripChecklist.map(() => false) };
}

export function normalizeNestTrip(raw) {
  const destination = String(raw?.destination || '').trim().slice(0, 50);
  const date = String(raw?.date || '');
  const parsed = new Date(date + 'T12:00:00');
  if (!destination || !/^\d{4}-\d{2}-\d{2}$/.test(date) || localDate(parsed) !== date) return null;
  return { destination, date, stops: String(raw.stops || '').trim().slice(0, 160), checked: tripChecklist.map((_, i) => raw.checked?.[i] === true) };
}

export function nestTripStops(trip) {
  const stops = trip.stops?.split(/[、,，\n→]/).map(stop => stop.trim()).filter(Boolean).slice(0, 5);
  return stops?.length ? stops : cityRoutes.get(trip.destination) || ['出发', trip.destination || '目的地'];
}

// 两个有界小记事本独立保存，更新行程不会把另一个标签页的新草稿写回旧值。
export function readNestNotebook(scope, storage = globalThis.localStorage) {
  const key = 'jarvis.nestDesk.v1:' + scope;
  let trip = null;
  try { trip = normalizeNestTrip(JSON.parse(storage.getItem(key + ':trip'))); } catch { /* 兼容损坏的旧行程。 */ }
  return { draft: (storage.getItem(key + ':draft') || '').slice(0, 12000), trip: trip || defaultNestTrip() };
}

export function saveNestNotebook(scope, part, value, storage = globalThis.localStorage) {
  const key = 'jarvis.nestDesk.v1:' + scope;
  if (part === 'draft') {
    storage.setItem(key + ':draft', String(value).slice(0, 12000));
    return;
  }
  const trip = normalizeNestTrip(value);
  if (part !== 'trip' || !trip) throw new Error('请填写目的地和有效日期。');
  storage.setItem(key + ':trip', JSON.stringify(trip));
}
