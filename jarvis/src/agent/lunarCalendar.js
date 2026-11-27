import { LUNAR_TABLE, QINGMING_DATES } from './lunarTable.js';
import { DAY_MS, timeInputError } from './timeMoment.js';

export function qingmingDate(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) throw timeInputError('清明日期需1900～2100年，范围外请提供目标日期');
  return QINGMING_DATES[year - 1900];
}

export function lunarToSolar({ year, month, day, leap = false }) {
  const row = LUNAR_TABLE.find(item => item[0] === year);
  if (!row || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || typeof leap !== 'boolean') throw timeInputError('农历需1900～2100年、1～12月、整数日和leap布尔值');
  if (leap && row[2] !== month) throw timeInputError('该农历年没有所指定的闰月');
  const index = month - 1 + (row[2] && (month > row[2] || leap) ? 1 : 0);
  if (day < 1 || day > row[3][index]) throw timeInputError('农历日期不存在');
  const days = row[3].slice(0, index).reduce((sum, n) => sum + n, 0) + day - 1;
  return new Date(Date.parse(row[1] + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}

export function solarToLunar(date) {
  const stamp = Date.parse(date + 'T00:00:00Z');
  const row = LUNAR_TABLE.findLast(item => date >= item[1]);
  let days = row ? Math.round((stamp - Date.parse(row[1] + 'T00:00:00Z')) / DAY_MS) : -1;
  if (!row || days < 0 || days >= row[3].reduce((sum, n) => sum + n, 0)) throw timeInputError('公历日期超出1900～2100农历年的日期表范围');
  let index = 0;
  while (days >= row[3][index]) days -= row[3][index++];
  const leap = Boolean(row[2] && index === row[2]);
  return { year: row[0], month: index + 1 - (row[2] && index >= row[2] ? 1 : 0), day: days + 1, leap };
}
