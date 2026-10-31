import { withWebDeadline } from './retrievalBudget.js';
import { httpError, throwControl } from '../core/networkRequest.js';
import { webBody } from './webBody.js';
import { newsPlain } from './newsSources.js';
import { beijingTimestamp, inSportsWindow } from './sportsWindow.js';

export const SCHEDULE_URL = 'https://www.zhibo8.com/';
let cached;
export const clearScheduleCache = () => { cached = null; };
const attr = (text, name) => text.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || '';

/** 只读页面明确的日期、联赛、对阵；不执行脚本、不猜比分/进行中/完场。 */
export function parseSchedulePage(html) {
  const events = [], seen = new Set();
  for (const match of String(html).slice(0, 1000000).matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const attrs = match[1], body = match[2];
    const date = attr(attrs, 'data-time');
    if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(date)) continue;
    const time = beijingTimestamp(date.slice(0, 10), date.slice(11));
    if (!Number.isFinite(time) || new Date(time + 28800000).toISOString().slice(0, 10) !== date.slice(0, 10)) continue;
    const league = newsPlain(body.match(/<span\b[^>]*class=["']_league["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '').slice(0, 100);
    const teamMarkup = body.match(/<span\b[^>]*class=["']_teams["'][^>]*>([\s\S]*?)<\/b>/i)?.[1] || '';
    const teams = newsPlain(teamMarkup).split(/\s+-\s+/);
    if (teams.length !== 2 || teams.some(t => !t.trim() || t.length > 100) || !league) continue;
    const id = attr(attrs, 'id').replace(/^saishi/, '').slice(0, 40);
    const key = `${id}|${date}|${teams.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [home, away] = attr(attrs, 'data-rightishome') === '1' ? teams.reverse() : teams;
    events.push({ id, time, date: date.slice(0, 10), clock: date.slice(11), league,
      sport: attr(attrs, 'data-type'), state: 'unknown', status: '计划赛程，实时状态未核实',
      home: { name: home.trim(), score: '' }, away: { name: away.trim(), score: '' } });
    if (events.length >= 600) break;
  }
  return events;
}

export async function fetchSchedulePage({ get, signal, refresh = false }) {
  if (!refresh && cached && Date.now() - cached.at < 30000) return cached.events;
  const events = await withWebDeadline(async activeSignal => {
    const response = await get(SCHEDULE_URL, { signal: activeSignal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw httpError(response.status, '', '国内赛程页');
    const bytes = await webBody(response, 1000000, activeSignal);
    throwControl(null, activeSignal);
    return parseSchedulePage(new TextDecoder().decode(bytes));
  }, { signal, timeoutMs: 4000 });
  if (!events.length) throw Object.assign(new Error('赛程页没有可核对的对阵和日期'), { code: 'SPORTS_PAGE_EMPTY' });
  cached = { at: Date.now(), events };
  return events;
}

export function schedulePageResult(events, { from, to, sports, team = '', focus = [], window, now }) {
  const days = new Set(events.map(e => e.date));
  const countDays = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  const covered = [...days].filter(d => d >= from && d <= to).length === countDays;
  const currentMinute = Math.floor(now / 60000) * 60000;
  const picked = events.filter(e => e.date >= from && e.date <= to && (!sports || sports.includes(e.sport))
    && (!team || `${e.home.name} ${e.away.name}`.toLowerCase().includes(team.toLowerCase()))
    && (!focus.length || focus.some(name => e.league.includes(name)))
    // 页面无状态；时间窗口仅匹配未来计划，不能冒充当前进行中。保留unknown给卡片。
    && (window.period === 'all' || window.period === 'afternoon' ? inSportsWindow(e.time, 'unknown', window)
      : e.time >= currentMinute && inSportsWindow(e.time, 'pre', window)));
  picked.sort((a, b) => a.time - b.time);
  const text = [`直播吧比分接口未取得完整结果，已读取公开赛程页。来源：${SCHEDULE_URL}`,
    `北京时间 ${from}${to !== from ? ' 至 ' + to : ''}${window.label ? '；' + window.label : ''}。查询于北京时间 ${new Date(now + 28800000).toISOString().slice(0, 16).replace('T', ' ')}。`,
    '以下是网页列出的计划赛程，实时状态未核实；不含已核实的实时比分、进行中或完场状态，不能据此称实时比分已查全。',
    ...picked.slice(0, 150).map(e => `- ${e.date} ${e.clock} ${e.league}：${e.home.name}（主）vs ${e.away.name}（客）`),
    !picked.length ? '页面未返回符合此窗口的对阵，不代表没有比赛。' : '',
    !covered ? '所查日期未全部覆盖，需继续搜索缺失日期。' : '',
    picked.length > 150 ? `共匹配${picked.length}场，仅列前150场。` : '',
    '未提供可核实的竞彩编号、停售时间和赔率。'].filter(Boolean).join('\n');
  return { text, events: picked, count: picked.length, covered };
}
