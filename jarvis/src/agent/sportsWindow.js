/** 时间筛选由程序完成，不让“马上”混进已过去的赛程；日期和时间均明确按北京时间。 */
export function sportsWindow(args = {}, now = Date.now()) {
  const period = args.period || 'all';
  const minutes = args.window_minutes ?? (period === 'around' ? 120 : 60);
  if (!['all', 'upcoming', 'remaining', 'afternoon', 'around'].includes(period) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 360) throw Object.assign(new Error('时间筛选需all/upcoming/remaining/afternoon/around，窗口为1至360分钟'), { code: 'INVALID_SPORTS_INPUT', kind: 'input' });
  const lastDate = args.end_date || args.date || new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const until = beijingTimestamp(lastDate, '00:00') + 24 * 3600_000;
  return { period, now, minutes, until, label: period === 'around' ? `当前前后各${minutes}分钟（含边界），仅进行中/中场及未开赛，进行中优先` : period === 'upcoming' ? `接下来${minutes}分钟，仅未开赛` : period === 'remaining' ? '指定北京日期内当前时刻之后的未开赛，直到当日24:00；不限定60分钟' : period === 'afternoon' ? '北京时间下午12:00（含）至18:00（不含）' : '' };
}

export function beijingTimestamp(date, clock) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) return NaN;
  return Date.parse(`${date}T${clock}:00+08:00`);
}

export function inSportsWindow(timestamp, state, window) {
  if (!window || window.period === 'all') return true;
  if (!Number.isFinite(timestamp)) return false;
  if (window.period === 'around') return ['pre', 'in', '1', '2'].includes(String(state)) && timestamp >= window.now - window.minutes * 60_000 && timestamp <= window.now + window.minutes * 60_000;
  if (window.period === 'upcoming') return ['pre', '1'].includes(String(state)) && timestamp >= window.now && timestamp < window.now + window.minutes * 60_000;
  if (window.period === 'remaining') return ['pre', '1'].includes(String(state)) && timestamp >= window.now && timestamp < window.until;
  const hour = new Date(timestamp + 8 * 3600_000).getUTCHours();
  return hour >= 12 && hour < 18;
}

export function inferSportsWindow(text) {
  text = String(text || '').split(/补充[:：]|用户最新修正[:：]/).at(-1);
  if (/全天|整天|所有时段|不限时段/.test(text)) return { period: 'all' };
  if (/下午/.test(text)) return { period: 'afternoon' };
  if (/前后|现在.{0,8}(?:什么球|哪些球|球赛|比赛)|当前.{0,8}(?:球赛|比赛)|正在进行/.test(text)) {
    const match = text.match(/前后\s*(\d+|一|二|两|三|四|五|六)\s*(分钟|(?:个)?小时)/);
    const count = match ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[match[1]] ?? Number(match[1])) : null;
    return { period: 'around', window_minutes: match ? count * (match[2] === '分钟' ? 1 : 60) : 120 };
  }
  if (/马上|即将|快开|接下来/.test(text)) {
    const match = String(text).match(/接下来\s*(\d+)\s*分钟/);
    const hours = String(text).match(/接下来\s*([\d.]+|一|二|两|三|四|五|六)\s*(?:个)?小时/);
    const hourCount = hours ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[hours[1]] ?? Number(hours[1])) : null;
    return { period: 'upcoming', window_minutes: match ? Number(match[1]) : hours ? hourCount * 60 : 60 };
  }
  if (/(?:今天|今日).{0,12}(?:剩余|剩下|还有|未开赛|没开赛)|(?:剩余|剩下|还没开赛|尚未开赛).{0,8}(?:比赛|球赛|赛程)/.test(text)) return { period: 'remaining' };
  // 指定日期/全天等原有明确范围优先；普通“足彩赛程”才默认附近窗口。
  if (/(?:足彩|竞彩足球)赛程/.test(text) && !/昨天|明天|后天|前天|昨晚|今晚|\d{1,2}\s*[月/-]\s*\d{1,2}|周[一二三四五六日天]|星期[一二三四五六日天]/.test(text)) return { period: 'around', window_minutes: 120 };
  return {};
}
