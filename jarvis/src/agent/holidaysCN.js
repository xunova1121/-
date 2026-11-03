import { DAY_MS, civilParts, civilStamp } from './timeMoment.js';

/** 国务院办公厅《关于2025年部分节假日安排的通知》（2024-11-12）、
 * 《关于2026年部分节假日安排的通知》（2025-11-04），来源 gov.cn。
 * 放假区间包含与周末连休，补班优先于周末判定；不猜未来尚未公布的调休。 */
export const HOLIDAYS_CN = {
  2025: {
    off: [['01-01', '01-01'], ['01-28', '02-04'], ['04-04', '04-06'], ['05-01', '05-05'], ['05-31', '06-02'], ['10-01', '10-08']],
    work: ['01-26', '02-08', '04-27', '09-28', '10-11'],
    festivals: { 元旦: '01-01', 春节: '01-29', 清明: '04-04', 劳动节: '05-01', 端午: '05-31', 中秋: '10-06', 国庆: '10-01' }
  },
  2026: {
    off: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
    work: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
    festivals: { 元旦: '01-01', 春节: '02-17', 清明: '04-05', 劳动节: '05-01', 端午: '06-19', 中秋: '09-25', 国庆: '10-01' }
  }
};

export function isWorkday(date) {
  const year = Number(date.slice(0, 4));
  const md = date.slice(5);
  const table = HOLIDAYS_CN[year];
  if (table?.work.includes(md)) return true;
  if (table?.off.some(([start, end]) => md >= start && md <= end)) return false;
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function dateStep(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const p = civilParts(civilStamp({ year, month, day }) + days * DAY_MS, 'UTC');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function workdayNote(years) {
  const missing = [...years].filter(year => !HOLIDAYS_CN[year]);
  return '中国工作日，按国务院放假调休表（2025、2026年）；' + (missing.length ? `${missing.join('、')}年节假日未内置，只排除了周末。` : '已计入调休补班日。');
}
