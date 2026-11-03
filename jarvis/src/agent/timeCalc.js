import { DAY_MS, TIME_ZONE, civilParts, civilStamp, momentInfo, parseMoment, timeInputError, timeZone } from './timeMoment.js';
import { dateStep, isWorkday, workdayNote } from './holidaysCN.js';
import { lunarToSolar, solarToLunar, qingmingDate } from './lunarCalendar.js';
export { parseMoment } from './timeMoment.js';

const finite = (value, label) => {
  const n = typeof value === 'string' && value.trim() && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw timeInputError(`${label}需为有限数字`);
  return n;
};
const calendarDays = (a, b, zone = TIME_ZONE) => (civilStamp({ ...civilParts(b, zone), hour: 0, minute: 0, second: 0 }) - civilStamp({ ...civilParts(a, zone), hour: 0, minute: 0, second: 0 })) / DAY_MS;

function difference(start, end, zone) {
  const minutes = (end - start) / 60000;
  const whole = Math.floor(Math.abs(minutes));
  return { start: momentInfo(start, zone), end: momentInfo(end, zone), totalMinutes: minutes, days: minutes / 1440, calendarDays: calendarDays(start, end, zone), duration: `${minutes < 0 ? '-' : ''}${Math.floor(whole / 1440)}天${Math.floor(whole % 1440 / 60)}小时${whole % 60}分`, note: '时长按实际经过时间计算，自然日差按所选时区的日期计算；不足一分钟保留在totalMinutes。' };
}

function festivalDate(festival, year) {
  const fixed = { 元旦: '01-01', 劳动节: '05-01', 国庆: '10-01' };
  const lunar = { 春节: [1, 1], 端午: [5, 5], 中秋: [8, 15] };
  if (fixed[festival]) return `${year}-${fixed[festival]}`;
  if (lunar[festival]) return lunarToSolar({ year, month: lunar[festival][0], day: lunar[festival][1] });
  if (festival === '清明') return qingmingDate(year);
  throw timeInputError('该节日未内置，请提供目标日期');
}

function workdays(data, now) {
  const start = momentInfo(parseMoment(data.start ?? data.date ?? '今天', now)).date;
  const years = new Set([Number(start.slice(0, 4))]);
  let cursor = start, count = 0;
  if (data.days !== undefined) {
    const days = finite(data.days, '工作日数');
    if (!Number.isSafeInteger(days) || Math.abs(days) > 10000) throw timeInputError('工作日数需为正负10000以内的整数');
    while (count < Math.abs(days)) {
      cursor = dateStep(cursor, Math.sign(days));
      years.add(Number(cursor.slice(0, 4)));
      if (isWorkday(cursor)) count++;
    }
    return { start, date: cursor, workdays: days, note: workdayNote(years) + '加减不计起始日。' };
  }
  const end = momentInfo(parseMoment(data.end, now)).date;
  const direction = end >= start ? 1 : -1;
  if (Math.abs(Date.parse(end) - Date.parse(start)) > 36600 * DAY_MS) throw timeInputError('工作日统计范围不能超过100年');
  while (cursor !== end) {
    cursor = dateStep(cursor, direction);
    years.add(Number(cursor.slice(0, 4)));
    if (isWorkday(cursor)) count += direction;
  }
  return { start, end, workdays: count, note: workdayNote(years) + '不含起始日、含结束日，反向区间为负数。' };
}

export function timeCalc(action, data = {}, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw timeInputError('data需为对象');
  if (action === 'add') {
    const start = parseMoment(data.date ?? data.start ?? '现在', now);
    const days = finite(data.days ?? 0, '天数'), hours = finite(data.hours ?? 0, '小时'), minutes = finite(data.minutes ?? 0, '分钟');
    const delta = days * DAY_MS + hours * 3600000 + minutes * 60000;
    if (Math.abs(delta) > 365000 * DAY_MS) throw timeInputError('加减范围不能超过1000年');
    const end = start + delta;
    return { ...momentInfo(end), start: momentInfo(start), crossedDays: calendarDays(start, end), note: '北京时间；加减按实际小时和分钟，crossedDays为跨越自然日数。' };
  }
  if (action === 'diff') return difference(parseMoment(data.start ?? data.startDate, now), parseMoment(data.end ?? data.endDate, now), TIME_ZONE);
  if (action === 'weekday') return momentInfo(parseMoment(data.date ?? '今天', now));
  if (action === 'countdown') {
    let date = data.date ?? data.target;
    const start = parseMoment(data.from ?? '现在', now);
    if (data.festival || /^(春节|元旦|清明|劳动节|端午|中秋|国庆)$/.test(date || '')) {
      const festival = data.festival || date;
      let year = data.year === undefined ? civilParts(start).year : finite(data.year, '年份');
      date = festivalDate(festival, year);
      if (data.year === undefined && momentInfo(start).date > date) date = festivalDate(festival, ++year);
    }
    return difference(start, parseMoment(date, now), TIME_ZONE);
  }
  if (action === 'workdays') return workdays(data, now);
  if (action === 'timezone') {
    const from = timeZone(data.fromZone ?? data.from ?? TIME_ZONE);
    const to = timeZone(data.toZone ?? data.to);
    if (!data.toZone && !data.to) throw timeInputError('请指定目标时区，如 to="纽约"');
    const stamp = parseMoment(data.date ?? '现在', now, from);
    return { from: momentInfo(stamp, from), to: momentInfo(stamp, to), note: '使用IANA时区规则，自动计入当地夏令时。' };
  }
  if (action === 'age') {
    const birth = parseMoment(data.birthday ?? data.date, now);
    const end = parseMoment(data.at ?? '今天', now);
    if (birth > end) throw timeInputError('生日不能晚于计算日期');
    const a = civilParts(birth), b = civilParts(end);
    const passed = b.month > a.month || b.month === a.month && b.day >= a.day;
    return { birthday: momentInfo(birth).date, at: momentInfo(end).date, years: b.year - a.year - Number(!passed), nominalYears: b.year - a.year + 1, note: '周岁按公历生日；2月29日生日在非闰年到3月1日满周岁。虚岁按公历年份差加1，不采用农历春节口径。' };
  }
  if (action === 'lunar') {
    const direction = data.direction ?? 'solar_to_lunar';
    if (direction === 'lunar_to_solar') return { date: lunarToSolar({ year: finite(data.year, '年'), month: finite(data.month, '月'), day: finite(data.day, '日'), leap: data.leap ?? false }), note: '农历1900～2100年日期表，闰月须明确leap=true。' };
    if (direction !== 'solar_to_lunar') throw timeInputError('direction用solar_to_lunar或lunar_to_solar');
    const date = momentInfo(parseMoment(data.date, now)).date;
    return { date, ...solarToLunar(date), note: '按北京时间日期换算，leap表示闰月。' };
  }
  throw timeInputError('action不支持，请选add/diff/weekday/countdown/workdays/timezone/age/lunar');
}

export function createTimeCalcTool(ctx = {}) {
  return {
    name: 'time_calc',
    description: '本地确定性时间计算，默认北京时间，认2026/11/3、11月3日下午3点50、明天、今晚8点、下周五、本月底。add:date,days/hours/minutes（例date:"现在",hours:23）；diff:start,end（例"今天","明天"）；weekday:date（例"下周五"）；countdown:date或festival（例festival:"春节"）；workdays:start,end或date,days（例date:"今天",days:5），中国2025/2026调休表，其他年份仅周末并注明；timezone:date,fromZone,toZone（例date:"现在",toZone:"纽约"）；age:birthday,at可选（例birthday:"2000/1/1"）；lunar:direction,date或year/month/day/leap（例direction:"lunar_to_solar",year:2026,month:1,day:1），农历1900～2100。不要用心算替代工具。',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'diff', 'weekday', 'countdown', 'workdays', 'timezone', 'age', 'lunar'] }, data: { type: 'object', additionalProperties: true } }, required: ['action', 'data'], additionalProperties: false },
    run: async ({ action, data }) => JSON.stringify(timeCalc(action, data, typeof ctx.now === 'function' ? ctx.now() : Date.now()))
  };
}
