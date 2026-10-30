/** 赛程卡刷新只读接口：固定数据源、总15秒，不创建任务、不请求模型。 */
import { getSportsScores } from '../src/agent/sportsScores.js';
import { sportsQuery } from '../src/agent/sportsSnapshot.js';
import { withWebDeadline } from '../src/agent/retrievalBudget.js';
export async function refreshSports(query, { get, signal } = {}) {
  if (query.size > 10 || [...query.keys()].some(k => !['period', 'window_minutes', 'date', 'end_date', 'sport', 'team', 'leagues'].includes(k))) throw Object.assign(new Error('不支持的赛程查询参数'), { status: 400 });
  const args = Object.fromEntries(query);
  if (args.window_minutes != null) args.window_minutes = Number(args.window_minutes);
  if (args.leagues) args.leagues = args.leagues.split(',');
  if (args.sport && !['all', 'football', 'basketball', 'tennis'].includes(args.sport)) throw Object.assign(new Error('不支持的运动项目'), { status: 400 });
  let snapshot;
  try {
    await withWebDeadline(s => getSportsScores(sportsQuery(args), { get, signal: s, refresh: true, onScores: value => { snapshot = value; } }), { signal, timeoutMs: 15000 });
  } catch (error) {
    if (error.code === 'INVALID_SPORTS_INPUT') error.status = 400;
    throw error;
  }
  return snapshot;
}
