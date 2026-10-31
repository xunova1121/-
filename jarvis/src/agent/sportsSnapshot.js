/** 只保存赛程卡的有界摘要，不把上游整份列表塞进对话或SSE。最多12场、两来源。 */
export const SPORTS_CARD_LIMIT = 12;
const text = (value, max = 64) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
export function sportsSnapshot({ args, groups, now, window, notice = '' }) {
  const rows = groups.flatMap(g => g.events.map(e => ({ ...e, source: g.source })));
  rows.sort((a, b) => ['around', 'forward_live'].includes(window?.period) ? Number(b.state === 'in') - Number(a.state === 'in') || a.time - b.time : a.time - b.time);
  return {
    version: 1, fetchedAt: now, query: sportsQuery(args), label: text(window?.label, 130),
    notice: text([notice, args.leagues?.length && groups.some(g => g.source === '直播吧') ? '直播吧未提供联赛名称，卡片尚未按所选联赛核实归属，请以文字核对结果为准。' : ''].filter(Boolean).join('；'), 240),
    sources: groups.slice(0, 2).map(g => ({ name: g.source, count: g.events.length })),
    events: rows.slice(0, SPORTS_CARD_LIMIT).map(e => ({
      id: text(e.id, 32), time: e.time, state: text(e.state, 12), status: text(e.status, 48),
      home: text(e.home.name), away: text(e.away.name),
      // 未赛的0只是占位，不展示为真实比分。
      score: ['in', 'post'].includes(e.state) && [e.home.score, e.away.score].every(s => /^\d{1,3}$/.test(String(s ?? ''))) ? `${e.home.score} : ${e.away.score}` : 'VS',
      league: text(e.league || '联赛名未提供'), source: e.source,
      jingcai: e.jingcai === true ? true : null
    })),
    truncated: rows.length > SPORTS_CARD_LIMIT,
    lotteryNote: '普通赛程；本次来源未提供可核实的竞彩场次编号、停售时间及赔率。赛事ID不是竞彩编号。'
  };
}

/** 对刷新查询只接收工具本来的字段，不接受URL、命令或任意上游地址。 */
export function sportsQuery(args = {}) {
  const out = {};
  for (const k of ['period', 'date', 'end_date', 'sport', 'team']) if (args[k] != null) out[k] = text(args[k], k === 'team' ? 64 : 16);
  if (args.window_minutes != null) out.window_minutes = args.window_minutes;
  if (args.teams != null) out.teams = (Array.isArray(args.teams) ? args.teams : []).slice(0, 12).map(v => text(v));
  if (args.leagues != null) out.leagues = (Array.isArray(args.leagues) ? args.leagues : [args.leagues]).slice(0, 40).map(v => text(v));
  return out;
}

/** 用户停用ESPN后，历史卡不再回放其数据；不删除历史消息正文。 */
export function withoutRetiredSports(value = {}) {
  const retired = row => /espn/i.test(String(row?.source || row?.name || ''));
  if (!(value.events || []).some(retired) && !(value.sources || []).some(retired)) return value;
  return { ...value, events: (value.events || []).filter(row => !retired(row)), sources: (value.sources || []).filter(row => !retired(row)),
    notice: '已移除停用来源的旧数据，请刷新国内赛程。' };
}
