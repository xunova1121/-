/** 民用日期按指定时区解释，默认北京时间；不使用宿主机器的本地时区。 */
export const DAY_MS = 86400000;
export const TIME_ZONE = 'Asia/Shanghai';
export const timeInputError = message => Object.assign(new Error(`${message}。可用写法：2026/11/3、11月3日下午3点50、明天、下周五；例如 date="2026-11-03 15:50"。`), { name: 'ValidationError', code: 'INVALID_TIME_INPUT' });

const ZONES = {
  北京: TIME_ZONE, 北京时间: TIME_ZONE, 上海: TIME_ZONE, 中国: TIME_ZONE,
  纽约: 'America/New_York', 洛杉矶: 'America/Los_Angeles', 伦敦: 'Europe/London',
  东京: 'Asia/Tokyo', 悉尼: 'Australia/Sydney', 巴黎: 'Europe/Paris',
  迪拜: 'Asia/Dubai', 新加坡: 'Asia/Singapore', 香港: 'Asia/Hong_Kong', UTC: 'UTC'
};
export function timeZone(value = TIME_ZONE) {
  const zone = ZONES[value] || value;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); }
  catch { throw timeInputError('时区不认识，请给城市名或 IANA 时区名（如 America/New_York）'); }
  return zone;
}

export function civilParts(stamp, zone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(stamp));
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
export function civilStamp(p) {
  const date = new Date(0);
  date.setUTCFullYear(p.year, p.month - 1, p.day);
  date.setUTCHours(p.hour || 0, p.minute || 0, p.second || 0, 0);
  return date.getTime();
}
const same = (a, b) => ['year', 'month', 'day', 'hour', 'minute', 'second'].every(key => (a[key] || 0) === (b[key] || 0));

/** 检查日期存在，DST 跳过/重复的钟点不擅自挑一个；明确偏移的 ISO 可消歧。 */
export function fromCivil(parts, zone = TIME_ZONE) {
  const wall = civilStamp(parts);
  if (!Number.isFinite(wall) || !same(civilParts(wall, 'UTC'), parts)) throw timeInputError('日期或钟点不存在');
  const offsets = new Set([-2, -1, 0, 1, 2].map(days => {
    const stamp = wall + days * DAY_MS;
    return civilStamp(civilParts(stamp, zone)) - stamp;
  }));
  const matches = [...offsets].map(offset => wall - offset).filter(stamp => same(civilParts(stamp, zone), parts));
  if (matches.length !== 1) throw timeInputError('该时区因夏令时存在重复或不存在的钟点，请提供带 UTC 偏移的 ISO 时间');
  return matches[0];
}

export function momentInfo(stamp, zone = TIME_ZONE) {
  const p = civilParts(stamp, zone);
  const pad = n => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`, weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: zone, weekday: 'long' }).format(stamp), timeZone: zone, iso: new Date(stamp).toISOString() };
}

export function parseMoment(text, now = Date.now(), zone = TIME_ZONE) {
  if (typeof text !== 'string' || !text.trim()) throw timeInputError('请提供日期或时间');
  const value = text.trim().normalize('NFKC');
  zone = timeZone(zone);
  if (/^(现在|此刻|now)$/i.test(value)) return Number(now);
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const wall = value.replace(/(?:Z|[+-]\d\d:\d\d)$/, '');
    parseMoment(wall, now, 'UTC'); // Date.parse 会把2月30日滚入3月，先验证民用日期。
    const stamp = Date.parse(value);
    if (!Number.isFinite(stamp)) throw timeInputError('时间偏移不合法');
    return stamp;
  }
  const current = civilParts(Number(now), zone);
  let p = { year: current.year, month: current.month, day: current.day, hour: 0, minute: 0, second: 0 };
  let tail = value;
  const absolute = value.match(/^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日|号)?/);
  if (absolute) {
    p = { ...p, year: Number(absolute[1] || current.year), month: Number(absolute[2]), day: Number(absolute[3]) };
    tail = value.slice(absolute[0].length);
  } else {
    const relative = value.match(/^(今天|明天|后天|昨天|前天|今晚|本月底|下周[一二三四五六日天])/);
    if (relative) {
      const word = relative[0];
      const base = civilStamp(p);
      const weekday = new Date(base).getUTCDay() || 7;
      const offset = word.startsWith('下周') ? 7 - weekday + '一二三四五六日'.indexOf(word.at(-1).replace('天', '日')) + 1 : ({ 今天: 0, 今晚: 0, 明天: 1, 后天: 2, 昨天: -1, 前天: -2 }[word] || 0);
      p = civilParts(word === '本月底' ? civilStamp({ year: p.year, month: p.month + 1, day: 1 }) - DAY_MS : base + offset * DAY_MS, 'UTC');
      tail = (word === '今晚' ? '晚上' : '') + value.slice(word.length);
    }
  }
  tail = tail.replace(/^[T\s]+/, '').trim();
  if (tail) {
    const clock = tail.match(/^(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?::|点|时)(?:(\d{1,2})(?:分)?)?(?::(\d{1,2})(?:\.\d{1,3})?|半|整)?$/);
    if (!clock) throw timeInputError('无法识别日期或钟点');
    let hour = Number(clock[2]);
    if (clock[1] && hour > 12) throw timeInputError('中文上午/下午钟点应为0至12点');
    if (['下午', '晚上', '中午'].includes(clock[1]) && hour < 12) hour += 12;
    if (['凌晨', '早上', '上午'].includes(clock[1]) && hour === 12) hour = 0;
    p = { ...p, hour, minute: tail.endsWith('半') ? 30 : Number(clock[3] || 0), second: Number(clock[4] || 0) };
  } else if (!absolute && !/^(今天|明天|后天|昨天|前天|本月底|下周[一二三四五六日天])$/.test(value)) throw timeInputError('无法识别日期');
  return fromCivil(p, zone);
}
