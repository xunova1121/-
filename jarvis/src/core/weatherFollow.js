import { cityKey, validCity } from './weather.js';

export const WEATHER_LOCATION_INTERVAL = 5 * 60 * 1000;
export const WEATHER_FOREGROUND_GAP = 10 * 1000;
const genericName = (name) => !name || ['当前位置', '附近'].includes(name);
/** 粗略坐标相同也可能跨区；只比较新定位实际提供的行政名称，不拿缺失区名抹掉已知名称。 */
export function sameWeatherPlace(a, b) {
  return (
    validCity(a) &&
    validCity(b) &&
    cityKey(a) === cityKey(b) &&
    (!b.district || b.district === a.district) &&
    (!b.city || b.city === a.city) &&
    (genericName(b.name) || b.name === a.name)
  );
}

/** 每个首页一个有界调度器；前台事件合并，未授权不弹框，旧定位不能覆盖手选/销毁后的页面。 */
export function createWeatherFollow({ client, locate, checkPermission, now = Date.now, onNotice = () => {}, active = () => true }) {
  let epoch = 0,
    busy = false,
    stopped = false,
    lastAttempt = -Infinity,
    running = null,
    control = null;
  const clearNotice = () => onNotice('');
  function cancel() {
    epoch++;
    lastAttempt = -Infinity;
    control?.abort();
  }
  function invalidate() {
    cancel();
    clearNotice();
  }
  async function perform({ foreground = false, force = false } = {}) {
    const before = client.state.city;
    const gap = foreground ? WEATHER_FOREGROUND_GAP : WEATHER_LOCATION_INTERVAL;
    if (stopped || busy || !active() || before?.source !== 'location' || (!force && now() - lastAttempt < gap)) return false;
    const ticket = epoch,
      revision = client.selectionRevision;
    const current = () =>
      !stopped &&
      ticket === epoch &&
      revision === client.selectionRevision &&
      active() &&
      client.state.city?.source === 'location' &&
      cityKey(client.state.city) === cityKey(before);
    const notice = (text) => {
      if (current()) onNotice(text);
    };
    const oldLabel = before.district || before.name;
    busy = true;
    control = new AbortController();
    const signal = control.signal;
    lastAttempt = now();
    try {
      if (!(await checkPermission())) {
        lastAttempt = -Infinity;
        notice(`尚未取得定位授权，仍显示${oldLabel}天气；可点“使用当前位置”`);
        return false;
      }
      if (!current()) return false;
      const next = await locate({ maximumAge: force || foreground ? 0 : 30000, requestPermission: false });
      if (!current()) return false;
      if (!validCity(next)) throw Object.assign(new Error('定位结果无效'), { code: 'WEATHER_LOCATION_INVALID' });
      if (sameWeatherPlace(before, next)) {
        clearNotice();
        return false;
      }
      const changed = await client.relocate(next, { signal });
      if (stopped || ticket !== epoch || !active()) return false;
      if (changed) clearNotice();
      else if (current()) notice(`位置未更新，仍显示${oldLabel}天气；可重新定位`);
      return changed;
    } catch {
      notice(`当前位置尚未确认，仍显示${oldLabel}天气；请检查系统定位或重新定位`);
      return false;
    } finally {
      busy = false;
      control = null;
    }
  }
  function check(options) {
    if (running) return running;
    running = perform(options).finally(() => {
      running = null;
    });
    return running;
  }
  return {
    check,
    invalidate,
    cancel,
    get busy() {
      return busy;
    },
    destroy() {
      stopped = true;
      cancel();
    }
  };
}
