/** 日期工具：一律按北京时间（UTC+8）算，不受服务器时区影响 */
const BJ = 8 * 3600_000;
const DAY = 86_400_000;

/** 北京时间的 YYYY-MM-DD */
export const bjDate = (t = Date.now()) => new Date(t + BJ).toISOString().slice(0, 10);

/** 两个北京日期之间相差几天（b - a） */
export function daysBetween(a, b) {
  const parse = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`日期写成 YYYY-MM-DD：${s}`);
    return Date.parse(`${s}T00:00:00+08:00`);
  };
  return Math.round((parse(b) - parse(a)) / DAY);
}

/** 孕周：从末次月经到某天，返回 { weeks, days } */
export function gestationalAge(lmp, onDate) {
  const total = daysBetween(lmp, onDate);
  if (total < 0) throw new Error('日期早于末次月经');
  return { weeks: Math.floor(total / 7), days: total % 7 };
}
