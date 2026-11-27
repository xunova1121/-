import { expect, it } from 'vitest';
import { defaultNestTrip, nestTripStops, normalizeNestTrip, readNestNotebook, saveNestNotebook } from '../src/ui/nestNotebook.js';

function memory() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

it('按当地日期确定最近的周六，跨月/跨年保持日期', () => {
  expect(defaultNestTrip(new Date(2026, 11, 31, 23)).date).toBe('2027-01-02');
  expect(defaultNestTrip(new Date(2027, 0, 2, 8)).date).toBe('2027-01-02');
});

it('自定义目的地与途经点可保存，草稿不覆盖同账号旅行手账', () => {
  const store = memory(), scope = 'server:alice';
  const trip = { destination: ' 南京 ', date: '2028-02-29', stops: '灵谷寺、明孝陵，东水关', checked: [true, false, true] };
  saveNestNotebook(scope, 'trip', trip, store);
  saveNestNotebook(scope, 'draft', '和小猫待一会儿', store);
  const saved = readNestNotebook(scope, store);
  expect(saved.trip).toEqual({ ...trip, destination: '南京' });
  expect(nestTripStops(saved.trip)).toEqual(['灵谷寺', '明孝陵', '东水关']);
  expect(saved.draft).toBe('和小猫待一会儿');
  expect(readNestNotebook('server:bob', store).draft).toBe('');
  expect(readNestNotebook('local:alice', store).trip.destination).toBe('杭州');
  expect(nestTripStops({ destination: '南京' })).toEqual(['出发', '南京']);
});

it('拒绝无效不可用日期，限制草稿和自定义路线大小', () => {
  const store = memory(), trip = defaultNestTrip();
  expect(normalizeNestTrip({ ...trip, date: '2027-02-29' })).toBeNull();
  expect(() => saveNestNotebook('scope', 'trip', { ...trip, destination: '  ' }, store)).toThrow();
  saveNestNotebook('scope', 'draft', '好'.repeat(13000), store);
  expect(readNestNotebook('scope', store).draft).toHaveLength(12000);
  expect(nestTripStops({ stops: '一、二、三、四、五、六' })).toHaveLength(5);
});
