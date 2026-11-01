import { withWebDeadline } from './request.js';
import { failureKind } from './recoveryData.js';
export const WEATHER_HEALTH = [
  { id: 'weather_qweather', label: '和风天气', region: 'cn', validation: 'existing' },
  { id: 'weather_openmeteo', label: 'Open-Meteo', region: 'global', validation: 'existing' },
  { id: 'weather_wttr', label: 'wttr.in', region: 'global', validation: 'existing' }
];
/** 用户 2026-11-01：三个天气源都在冷却时一律跳过，等于“装死”30分钟；全部冷却时照样逐个真试。 */
export async function allWeatherCooling(ids, health) {
  if (!health) return false;
  const states = await Promise.all(ids.map(id => health.get(id).catch(() => null)));
  return states.every(state => state?.cooling);
}
export async function weatherProvider(id, work, { signal, timeoutMs, health, ignoreCooling = false }) {
  const started = performance.now();
  if (signal?.aborted) throw signal.reason;
  const state = ignoreCooling ? null : await health?.get(id);
  if (state?.cooling) throw Object.assign(new Error('来源暂时不可用'), { code: 'LOOKUP_SOURCE_COOLING' });
  try {
    const result = await withWebDeadline(work, { signal, timeoutMs });
    if (signal?.aborted) throw signal.reason;
    await health?.record(id, { state: 'ok', elapsedMs: performance.now() - started }, { signal });
    return result;
  } catch (error) {
    if (!signal?.aborted && error.code !== 'RETRIEVAL_BUDGET' && error.name !== 'AbortError') await health?.record(id, { state: 'failed', code: failureKind(error) === 'auth' ? 'LOOKUP_AUTH' : error.code || error.name, elapsedMs: performance.now() - started }, { signal });
    throw error;
  }
}

export { shortSourceRetry } from './sourceRetry.js';
