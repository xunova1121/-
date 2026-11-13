import { describe, it, expect } from 'vitest';
import { timeCalc, parseMoment, createTimeCalcTool } from '../src/agent/timeCalc.js';
import { verifyNumbers } from '../src/agent/verifyNumbers.js';
import { solarToLunar, lunarToSolar } from '../src/agent/lunarCalendar.js';
import { LUNAR_TABLE } from '../src/agent/lunarTable.js';
import { CORE } from '../src/agent/toolLoader.js';
import { PARALLEL_SAFE } from '../src/agent/agent.js';
const now = Date.parse('2026-11-03T15:50:00+08:00');
const calc = (action, data) => timeCalc(action, data, now);

describe('时间解析按北京时间、保留不存在日期校验', () => {
  it.each(['2026-11-03 15:50', '2026-11-03T15:50:00', '11月3日下午3点50'])('%s认作同一个时刻', text => expect(parseMoment(text, now)).toBe(now));
  it.each(['2026-11-03', '2026/11/3', '11月3日', '今天'])('%s认作北京当天零点', text => expect(parseMoment(text, now)).toBe(Date.parse('2026-11-03T00:00:00+08:00')));
  it('相对日期、今晚、月底、跨年下周和带偏移ISO', () => {
    expect(calc('weekday', { date: '明天' }).date).toBe('2026-11-04');
    expect(calc('weekday', { date: '后天' }).date).toBe('2026-11-05');
    expect(calc('weekday', { date: '昨天' }).date).toBe('2026-11-02');
    expect(calc('weekday', { date: '本月底' }).date).toBe('2026-11-30');
    expect(calc('weekday', { date: '今晚8点' }).time).toBe('20:00:00');
    expect(parseMoment('2026-11-03T07:50:00Z', now)).toBe(now);
    expect(timeCalc('weekday', { date: '下周五' }, Date.parse('2026-12-31T23:00:00+08:00')).date).toBe('2027-01-08');
  });
  it.each(['2026-02-30', '2026-13-01', '2026-11-03 25:00', '2026-11-03 10:60', '2026-02-30T12:00:00Z', '随便哪天'])('拒绝%s并给例子', text => expect(() => parseMoment(text, now)).toThrow('可用写法'));
});

describe('八类时间计算', () => {
  it('add：23小时跨天，90分钟，组合减法跨年', () => {
    expect(calc('add', { date: '现在', hours: 23 })).toMatchObject({ date: '2026-11-04', time: '14:50:00', weekday: '星期三', crossedDays: 1 });
    expect(calc('add', { date: '现在', minutes: 90 }).time).toBe('17:20:00');
    expect(calc('add', { date: '2026-01-01 01:00', hours: -2, minutes: -30 })).toMatchObject({ date: '2025-12-31', time: '22:30:00', crossedDays: -1 });
  });
  it('add：闰年跨月、旧date_add也接受钟点而纯日期结果不变', () => {
    expect(calc('add', { date: '2024/2/28', days: 2 }).date).toBe('2024-03-01');
    expect(verifyNumbers('date_add', { date: '2026-11-03 15:50', days: 0, hours: 23 }, now)).toMatchObject({ date: '2026-11-04', time: '14:50:00' });
    expect(verifyNumbers('date_add', { date: '2024-02-28', days: 1 }).date).toBe('2024-02-29');
  });
  it('diff：时分和自然日数分开，不误写成整天', () => {
    expect(calc('diff', { start: '8:30', end: '17:45' })).toMatchObject({ totalMinutes: 555, duration: '0天9小时15分', calendarDays: 0 });
    expect(calc('diff', { start: '2026-11-03 23:30', end: '明天0点' })).toMatchObject({ totalMinutes: 30, calendarDays: 1 });
  });
  it('diff：反向、同日和旧接口保留', () => {
    expect(calc('diff', { start: '明天', end: '今天' }).totalMinutes).toBe(-1440);
    expect(calc('diff', { start: '现在', end: '现在' }).totalMinutes).toBe(0);
    expect(verifyNumbers('date_difference', { startDate: '2024/2/28', endDate: '2024/3/1' }).days).toBe(2);
  });
  it('weekday：绝对日期和下周五', () => {
    expect(calc('weekday', { date: '2026-11-03' }).weekday).toBe('星期二');
    expect(calc('weekday', { date: '下周五' })).toMatchObject({ date: '2026-11-13', weekday: '星期五' });
  });
  it('weekday：北京时间跨UTC日期，不依赖宿主时区', () => {
    expect(timeCalc('weekday', { date: '今天' }, Date.parse('2026-11-03T16:30:00Z'))).toMatchObject({ date: '2026-11-04', weekday: '星期三' });
  });
  it('countdown：2026春节真实日期，已过春节找下一年', () => {
    expect(timeCalc('countdown', { festival: '春节' }, Date.parse('2026-02-16T00:00:00+08:00'))).toMatchObject({ calendarDays: 1, end: { date: '2026-02-17' } });
    expect(calc('countdown', { festival: '春节' }).end.date).toBe('2027-02-06');
  });
  it('countdown：元旦、端午、中秋、清明、指定时间', () => {
    expect(calc('countdown', { festival: '元旦' }).end.date).toBe('2027-01-01');
    for (const [festival, date] of [['端午', '2026-06-19'], ['中秋', '2026-09-25'], ['清明', '2026-04-05'], ['劳动节', '2026-05-01'], ['国庆', '2026-10-01']]) expect(calc('countdown', { festival, year: 2026 }).end.date).toBe(date);
    expect(calc('countdown', { date: '今晚8点' }).totalMinutes).toBe(250);
  });
  it('清明节气不受仅2025/2026放假调休表限制，过了今年取下一年', () => {
    expect(calc('countdown', { festival: '清明' }).end.date).toBe('2027-04-05');
    expect(calc('countdown', { festival: '清明', year: 2025 }).end.date).toBe('2025-04-04');
    expect(() => calc('countdown', { festival: '清明', year: 2101 })).toThrow('1900～2100');
  });
  it('workdays：节假日不计、调休周末计入', () => {
    expect(calc('workdays', { date: '2026-02-13', days: 1 }).date).toBe('2026-02-14');
    expect(calc('workdays', { date: '2026-02-14', days: 1 }).date).toBe('2026-02-24');
    expect(calc('workdays', { start: '2026-02-13', end: '2026-02-28' }).workdays).toBe(6);
    expect(calc('workdays', { date: '2025-01-24', days: 1 }).date).toBe('2025-01-26');
  });
  it('workdays：负数、年底区间和未知年份注明仅周末', () => {
    expect(calc('workdays', { date: '2026-02-24', days: -1 }).date).toBe('2026-02-14');
    expect(calc('workdays', { start: '今天', end: '12月31日' }).workdays).toBe(42);
    expect(calc('workdays', { date: '2027-01-01', days: 1 })).toMatchObject({ date: '2027-01-04', note: expect.stringContaining('2027年节假日未内置，只排除了周末') });
  });
  it('timezone：北京转纽约、反向伦敦，自动夏令时', () => {
    expect(calc('timezone', { date: '现在', toZone: '纽约' }).to).toMatchObject({ date: '2026-11-03', time: '02:50:00' });
    expect(calc('timezone', { date: '2026-07-01 12:00', fromZone: '伦敦', toZone: '北京' }).to.time).toBe('19:00:00');
    expect(calc('timezone', { date: '2026-07-01 12:00', toZone: '纽约' }).to.time).toBe('00:00:00');
  });
  it('timezone：夏令时缺口/重复时刻报可操作错误，显式偏移可消歧', () => {
    for (const date of ['2026-03-08 02:30', '2026-11-01 01:30']) expect(() => calc('timezone', { date, fromZone: '纽约', toZone: '北京' })).toThrow('夏令时');
    expect(calc('timezone', { date: '2026-11-01T01:30:00-04:00', fromZone: '纽约', toZone: '北京' }).to.time).toBe('13:30:00');
  });
  it('age：生日之前/当天周岁及虚岁口径', () => {
    expect(calc('age', { birthday: '2000-11-04' })).toMatchObject({ years: 25, nominalYears: 27 });
    expect(calc('age', { birthday: '2000-11-03' })).toMatchObject({ years: 26, nominalYears: 27 });
  });
  it('age：闰日生日和未来生日校验', () => {
    expect(calc('age', { birthday: '2000-02-29', at: '2025-02-28' }).years).toBe(24);
    expect(calc('age', { birthday: '2000-02-29', at: '2025-03-01' }).years).toBe(25);
    expect(() => calc('age', { birthday: '明天' })).toThrow('生日不能');
  });
  it('lunar：春节和闰六月双向，未来春节不采用ICU误差', () => {
    expect(calc('lunar', { date: '2026-02-17' })).toMatchObject({ year: 2026, month: 1, day: 1, leap: false });
    expect(calc('lunar', { direction: 'lunar_to_solar', year: 2026, month: 1, day: 1 }).date).toBe('2026-02-17');
    expect(calc('lunar', { direction: 'lunar_to_solar', year: 2025, month: 6, day: 1, leap: true }).date).toBe('2025-07-25');
    expect(calc('lunar', { date: '2025-07-25' })).toMatchObject({ year: 2025, month: 6, day: 1, leap: true });
  });
  it('lunar：完整201年月份首尾往返与相邻年份连续，非法范围拒绝', () => {
    for (const [year, start, leap, months] of LUNAR_TABLE) {
      expect(lunarToSolar({ year, month: 1, day: 1 })).toBe(start);
      for (let index = 0; index < months.length; index++) {
        const month = index + 1 - Number(Boolean(leap && index >= leap));
        for (const day of [1, months[index]]) {
          const expected = { year, month, day, leap: Boolean(leap && index === leap) };
          expect(solarToLunar(lunarToSolar(expected))).toEqual(expected);
        }
      }
      if (year < 2100) expect((Date.parse(LUNAR_TABLE[year - 1899][1]) - Date.parse(start)) / 86400000).toBe(months.reduce((a, b) => a + b));
    }
    expect(() => lunarToSolar({ year: 2026, month: 1, day: 1, leap: true })).toThrow('闰月');
    expect(() => solarToLunar('1899-12-31')).toThrow('范围');
  });
  it('工具常驻、可并行、注入时钟可复现', async () => {
    expect(CORE.has('time_calc')).toBe(true);
    expect(PARALLEL_SAFE.has('time_calc')).toBe(true);
    expect(JSON.parse(await createTimeCalcTool({ now: () => now }).run({ action: 'add', data: { hours: 23 } })).date).toBe('2026-11-04');
  });
});
