import { sportsWindow, inSportsWindow, inferSportsWindow } from './sportsWindow.js';
import { httpError, throwControl } from '../core/networkRequest.js';
import { withWebDeadline } from './retrievalBudget.js';
import { errorKind } from '../core/suggest.js';
import { fetchZhibo8, zhibo8Result } from './sportsZhibo8.js';
/**
 * 赛程和赛果：按北京时间的某一天，把各联赛的比赛（没开打的给开球时间，打完的给比分）一次查齐。
 * 不走搜索引擎（搜索摘要零散、经常漏场次），直接读比分接口（不用密钥），手机、电脑、服务器都能用：
 *   1. 直播吧（国内连得上，中文队名，只有大约昨天到明天，见 sportsZhibo8.js）
 *   2. ESPN（国外接口，能查任意日期；国内服务器连不上，2026-10-25 用户服务器实测）
 *
 * 为什么要自己算日期：ESPN 按美国时间归档，北京时间的“今天”跨它的两天（欧洲晚场在北京凌晨）。
 * 所以按北京日期往前多取一天，再按每场的开球时间筛回北京当天。
 *
 * 覆盖不到的（CBA、中甲、网球、排球、电竞……）在结果里写明，让模型用 web_search 补，不把“没查”说成“没有比赛”。
 */

/** 要查的赛事：ESPN 代码 → 中文名。新增前确认 ESPN 有这个代码（代码不对只会算“没取到”，不会出错） */
export const LEAGUES = [
  // 国内和亚洲
  { code: 'chn.1', sport: 'soccer', name: '中超' },
  { code: 'afc.champions', sport: 'soccer', name: '亚冠精英联赛' },
  { code: 'jpn.1', sport: 'soccer', name: '日职联' },
  { code: 'kor.1', sport: 'soccer', name: '韩K联' },
  { code: 'aus.1', sport: 'soccer', name: '澳超' },
  { code: 'ksa.1', sport: 'soccer', name: '沙特联' },
  // 欧洲五大联赛和欧战
  { code: 'eng.1', sport: 'soccer', name: '英超' },
  { code: 'esp.1', sport: 'soccer', name: '西甲' },
  { code: 'ger.1', sport: 'soccer', name: '德甲' },
  { code: 'ita.1', sport: 'soccer', name: '意甲' },
  { code: 'fra.1', sport: 'soccer', name: '法甲' },
  { code: 'uefa.champions', sport: 'soccer', name: '欧冠' },
  { code: 'uefa.europa', sport: 'soccer', name: '欧联杯' },
  { code: 'uefa.europa.conf', sport: 'soccer', name: '欧协联' },
  // 其他联赛
  { code: 'eng.2', sport: 'soccer', name: '英冠' },
  { code: 'ned.1', sport: 'soccer', name: '荷甲' },
  { code: 'por.1', sport: 'soccer', name: '葡超' },
  { code: 'sco.1', sport: 'soccer', name: '苏超' },
  { code: 'tur.1', sport: 'soccer', name: '土超' },
  { code: 'bel.1', sport: 'soccer', name: '比甲' },
  { code: 'usa.1', sport: 'soccer', name: '美职联' },
  { code: 'mex.1', sport: 'soccer', name: '墨超' },
  { code: 'bra.1', sport: 'soccer', name: '巴甲' },
  { code: 'arg.1', sport: 'soccer', name: '阿甲' },
  // 杯赛和国家队
  { code: 'eng.fa', sport: 'soccer', name: '英足总杯' },
  { code: 'eng.league_cup', sport: 'soccer', name: '英联赛杯' },
  { code: 'esp.copa_del_rey', sport: 'soccer', name: '国王杯' },
  { code: 'ger.dfb_pokal', sport: 'soccer', name: '德国杯' },
  { code: 'ita.coppa_italia', sport: 'soccer', name: '意大利杯' },
  { code: 'fra.coupe_de_france', sport: 'soccer', name: '法国杯' },
  { code: 'conmebol.libertadores', sport: 'soccer', name: '南美解放者杯' },
  { code: 'fifa.world', sport: 'soccer', name: '世界杯' },
  { code: 'fifa.worldq.afc', sport: 'soccer', name: '世预赛亚洲区' },
  { code: 'fifa.worldq.uefa', sport: 'soccer', name: '世预赛欧洲区' },
  { code: 'afc.asian.cup', sport: 'soccer', name: '亚洲杯' },
  { code: 'uefa.nations', sport: 'soccer', name: '欧国联' },
  { code: 'fifa.friendly', sport: 'soccer', name: '国际友谊赛' },
  // 篮球
  { code: 'nba', sport: 'basketball', name: 'NBA' },
  { code: 'wnba', sport: 'basketball', name: 'WNBA' }
];

/** 常说的一组赛事 */
const GROUPS = { 五大联赛: ['eng.1', 'esp.1', 'ger.1', 'ita.1', 'fra.1'], 欧战: ['uefa.champions', 'uefa.europa', 'uefa.europa.conf'] };

/** 查不了的项目：问到时让模型去搜 */
export const NOT_COVERED = 'CBA、中甲、中乙、女足联赛、网球、排球、乒乓球、羽毛球、F1、电竞、斯诺克';

const SPORT_NAME = { soccer: '足球', basketball: '篮球' };
/** 同时查的赛事数：太多容易被限流，太少慢 */
const PARALLEL = 10;
/** 单个赛事最多等多久（毫秒）；连不上的赛事算“没取到”，不拖住整个结果 */
const LEAGUE_TIMEOUT_MS = 7000;
/** 一次最多列多少场：再多模型也读不过来，提示按联赛缩小 */
const MAX_EVENTS = 150;
/** 一次最多跨几天 */
const MAX_DAYS = 3;
const BEIJING_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;

const invalid = (message) => Object.assign(new Error(message), { name: 'ValidationError', code: 'INVALID_SPORTS_INPUT' });

/** 北京时间的日期（YYYY-MM-DD） */
export const beijingDate = (ms) => new Date(ms + BEIJING_MS).toISOString().slice(0, 10);
/** 北京时间的“时:分” */
const beijingClock = (ms) => new Date(ms + BEIJING_MS).toISOString().slice(11, 16);
const WEEK = '日一二三四五六';
const weekday = (date) => `周${WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;

function checkDate(value) {
  const v = String(value);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw invalid('日期要写成 YYYY-MM-DD（北京时间）');
  return v;
}
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const compact = (date) => date.replaceAll('-', '');

/** 用户说的赛事（中文名、ESPN 代码、“五大联赛”这类分组）→ 要查的赛事 */
export function pickLeagues({ sport = 'all', leagues } = {}) {
  const wanted = (Array.isArray(leagues) ? leagues : leagues ? [leagues] : []).map((x) => String(x).trim()).filter(Boolean);
  if (wanted.length) {
    const codes = new Set();
    for (const w of wanted) {
      for (const c of GROUPS[w] ?? []) codes.add(c);
      const hit = LEAGUES.find((l) => l.code === w.toLowerCase() || l.name === w || w.includes(l.name));
      if (hit) codes.add(hit.code);
    }
    return LEAGUES.filter((l) => codes.has(l.code));
  }
  if (sport === 'tennis') return []; // ESPN 这边没接网球
  const s = { football: 'soccer', soccer: 'soccer', basketball: 'basketball' }[sport];
  return s ? LEAGUES.filter((l) => l.sport === s) : LEAGUES;
}

const STATUS = { pre: '未开赛', in: '进行中', post: '完场' };
/** 一场比赛的状态（中文） */
function statusOf(event) {
  const type = event.status?.type ?? event.competitions?.[0]?.status?.type ?? {};
  const name = String(type.name || '');
  if (/POSTPONED/.test(name)) return { state: 'post', text: '延期' };
  if (/CANCEL/.test(name)) return { state: 'post', text: '取消' };
  if (/ABANDON|SUSPENDED/.test(name)) return { state: 'post', text: '中断' };
  const state = type.state || 'pre';
  if (state === 'in') return { state, text: `进行中 ${type.shortDetail || ''}`.trim() };
  if (state === 'post') {
    // 加时、点球决胜写清楚（只写“完场”会让人以为是常规时间的比分）
    const extra = /Pens|PK|penalt/i.test(type.detail || type.shortDetail || '') ? '（含点球）' : /AET|ET|OT/i.test(type.shortDetail || '') ? '（含加时）' : '';
    return { state, text: `完场${extra}` };
  }
  return { state: 'pre', text: STATUS.pre };
}

/** ESPN 的一场比赛 → 我们要的几项 */
export function normalizeEvent(event, league) {
  const time = Date.parse(event.date);
  const comp = event.competitions?.[0] ?? {};
  const side = (homeAway) => {
    const c = (comp.competitors ?? []).find((x) => x.homeAway === homeAway) ?? {};
    return {
      name: c.team?.displayName || c.team?.shortDisplayName || c.team?.name || '未知',
      score: c.score ?? '',
      shootout: c.shootoutScore
    };
  };
  const status = statusOf(event);
  return {
    id: String(event.id ?? ''),
    league: league.name,
    sport: league.sport,
    time,
    home: side('home'),
    away: side('away'),
    state: status.state,
    status: status.text,
    venue: comp.venue?.fullName || ''
  };
}

/** 一行文字：足球主队在前；篮球按国内习惯也写“主队 vs 客队”，并标出主客 */
function lineOf(e) {
  const clock = beijingClock(e.time);
  const score = e.state === 'pre' || e.home.score === '' ? 'vs' : `${e.home.score}-${e.away.score}`;
  const pens = e.home.shootout != null && e.away.shootout != null ? `，点球 ${e.home.shootout}-${e.away.shootout}` : '';
  return `- ${clock} ${e.status}：${e.home.name}（主）${score} ${e.away.name}（客）${pens}`;
}

/** 整理成给模型看的文字（按北京日期、赛事分组） */
export function formatScores({ events, from, to, asked, failed, now = Date.now(), window = null }) {
  const lines = [`北京时间 ${from}（${weekday(from)}）${to !== from ? ` 至 ${to}（${weekday(to)}）` : ''}的赛程和赛果，来源 ESPN（espn.com），查询于北京时间 ${beijingDate(now)} ${beijingClock(now)}。时间均已换算成北京时间。`];
  const shown = events.slice(0, MAX_EVENTS);
  if (window?.label) lines.push('时间筛选：' + window.label + '；不代表全天完整赛程。');
  if (!shown.length) lines.push(window?.label ? '\n这个时间窗口未返回符合条件的比赛，不代表其他时段或联赛没有比赛。' : '\n查到的赛事在这段时间都没有比赛。');
  let day = '';
  let league = '';
  for (const e of shown) {
    const d = beijingDate(e.time);
    if (d !== day) {
      day = d;
      league = '';
      if (from !== to) lines.push(`\n# ${d}（${weekday(d)}）`);
    }
    if (e.league !== league) {
      league = e.league;
      lines.push(`\n## ${league}`);
    }
    lines.push(lineOf(e));
  }
  if (events.length > shown.length) lines.push(`\n（共 ${events.length} 场，只列了前 ${shown.length} 场；要看其余的，用 leagues 指定赛事再查）`);
  const ok = asked.filter((l) => !failed.includes(l));
  lines.push(`\n已查的赛事（${ok.length} 个）：${ok.map((l) => l.name).join('、') || '无'}。`);
  if (failed.length) lines.push(`没取到的（${failed.length} 个，这些赛事的场次可能缺，需要时用 web_search 补）：${failed.map((l) => l.name).join('、')}。`);
  lines.push(`不在查询范围：${NOT_COVERED}——用户问到时用 web_search 补查，不要说成“没有比赛”。`);
  lines.push('球队名是英文，回答时用国内常用的中文译名；比分以这里为准，未开赛的不要编比分。');
  return lines.join('\n');
}

/** 短时缓存：同一轮里先查过、模型又查一次时不重复联网。最多 200 条，60 秒过期 */
const cache = new Map();
const CACHE_MAX = 200;
const CACHE_MS = 60_000;
function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}
export const clearScoresCache = () => cache.clear();

/** 读一个赛事某几天的比赛 */
async function fetchLeague(league, range, { get, signal }) {
  const key = `${league.code}|${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.code}/scoreboard?dates=${range}&limit=300`;
  const data = await withWebDeadline(
    async (s) => {
      const response = await get(url, { signal: s });
      if (!response.ok) throw httpError(response.status, '', 'ESPN');
      return response.json();
    },
    { signal, timeoutMs: LEAGUE_TIMEOUT_MS }
  );
  const events = (data?.events ?? []).map((e) => normalizeEvent(e, league));
  remember(key, events);
  return events;
}

/**
 * @param {{ date?: string, end_date?: string, sport?: string, leagues?: string[]|string, team?: string }} args
 * @param {{ get: (url: string, init?: object) => Promise<Response>, signal?: AbortSignal, retrieval?: object, now?: number, progress?: (m: string) => void }} o
 */
export async function getSportsScores(args = {}, { get, signal, retrieval, now = Date.now(), progress } = {}) {
  const from = args.date ? checkDate(args.date) : beijingDate(now);
  const window = sportsWindow(args, now);
  let to = args.end_date ? checkDate(args.end_date) : from;
  if (window.period === 'upcoming' && !args.end_date && from === beijingDate(now)) to = beijingDate(now + window.minutes * 60_000);
  if (to < from) throw invalid('结束日期不能早于开始日期');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_DAYS) throw invalid(`一次最多查 ${MAX_DAYS} 天`);
  const asked = pickLeagues(args);
  const named = (Array.isArray(args.leagues) ? args.leagues : args.leagues ? [args.leagues] : []).map((x) => String(x).trim()).filter(Boolean);
  // 整次查询算一次读取（一个数据接口，不按赛事个数扣）
  retrieval?.consume('read');
  // 先问直播吧：国内连得上；要查的每一天它都有就直接用
  let partial = null;
  try {
    progress?.('正在查直播吧的赛程和比分');
    const list = await fetchZhibo8({ get, signal });
    const r = zhibo8Result(list, { from, to, today: beijingDate(now), sports: zhibo8Sports(args, asked, named), team: args.team, focus: named, clock: `${beijingDate(now)} ${beijingClock(now)}`, window });
    if (r.covered) return r.text;
    if (r.count) partial = r;
  } catch (error) {
    throwControl(error, signal);
  }
  if (!asked.length) {
    if (partial) return partial.text;
    throw invalid(`没认出要查的赛事。能查：${LEAGUES.map((l) => l.name).join('、')}；查不了：${NOT_COVERED}（用 web_search）`);
  }
  // 北京 from 日 0 点 = 美国时间 from 前一天中午：往前多取一天，再按开球时间筛
  const range = `${compact(shiftDate(from, -1))}-${compact(to)}`;
  const start = Date.parse(`${from}T00:00:00Z`) - BEIJING_MS;
  const end = Date.parse(`${to}T00:00:00Z`) - BEIJING_MS + DAY_MS;
  // 前几个赛事全是网络不通：说明连不上 ESPN，剩下的不再等（否则几十个赛事一个个超时要等一分钟）
  const stop = new AbortController();
  const relay = () => stop.abort(signal?.reason);
  signal?.addEventListener('abort', relay, { once: true });
  const results = new Map();
  const failed = [];
  let done = 0;
  let networkFails = 0;
  let next = 0;
  progress?.(`正在查 ${asked.length} 个赛事的赛程和比分`);
  const worker = async () => {
    while (next < asked.length && !stop.signal.aborted) {
      const league = asked[next++];
      try {
        results.set(league.code, await fetchLeague(league, range, { get, signal: stop.signal }));
      } catch (error) {
        throwControl(null, signal);
        // 已判定连不上、主动停掉的请求：不算用户停止
        if (!stop.signal.aborted) throwControl(error, signal);
        failed.push(league);
        if (['network', 'timeout'].includes(errorKind(error))) networkFails++;
        if (!results.size && networkFails >= Math.min(PARALLEL, asked.length)) stop.abort();
      }
      done++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, asked.length) }, worker));
  } finally {
    signal?.removeEventListener('abort', relay);
  }
  throwControl(null, signal);
  if (!results.size) {
    if (partial) return `${partial.text}\n（ESPN 也连不上，缺的日期用 web_search 补）`;
    throw Object.assign(new Error(`连不上 ESPN 比分接口（${asked.length} 个赛事都没取到）。改用 web_search 查，中文搜索词带上日期和联赛名，如“${from} 中超 赛程 比分”`), { code: 'SPORTS_UNAVAILABLE', kind: 'network' });
  }
  const team = String(args.team || '').trim().toLowerCase();
  const seen = new Set();
  const events = [];
  for (const league of asked) {
    for (const e of results.get(league.code) ?? []) {
      if (!Number.isFinite(e.time) || e.time < start || e.time >= end) continue;
      // 同一场可能同时出现在两个赛事里（如友谊赛），按 id 去重
      if (e.id && seen.has(e.id)) continue;
      if (team && !`${e.home.name} ${e.away.name}`.toLowerCase().includes(team)) continue;
      seen.add(e.id);
      if (inSportsWindow(e.time, e.state, window)) events.push(e);
    }
  }
  // 按日期、赛事（按列表顺序：国内、亚洲在前）、开球时间排
  const order = new Map(LEAGUES.map((l, i) => [l.name, i]));
  events.sort((a, b) => window.period !== 'all' ? a.time - b.time : beijingDate(a.time).localeCompare(beijingDate(b.time)) || order.get(a.league) - order.get(b.league) || a.time - b.time);
  progress?.(`查到 ${events.length} 场（${done - failed.length}/${asked.length} 个赛事有数据）`);
  return formatScores({ events, from, to, asked, failed, now, window });
}

/** 直播吧按项目筛：用户点名的联赛决定项目（CBA、中甲这类 ESPN 没有的也认得） */
function zhibo8Sports(args, asked, named) {
  if (named.length) {
    const set = new Set();
    for (const n of named) {
      if (/CBA|NBA|WNBA|篮/i.test(n)) set.add('basketball');
      else if (/网球|ATP|WTA/i.test(n)) set.add('tennis');
      else set.add('football');
    }
    for (const l of asked) set.add(l.sport === 'soccer' ? 'football' : l.sport);
    return [...set];
  }
  return { football: ['football'], basketball: ['basketball'], tennis: ['tennis'] }[args.sport] ?? null;
}

export function createSportsScoresTool(ctx = {}) {
  const get = ctx.fetchViaGateway ?? ctx.fetchImpl ?? ((...args) => fetch(...args));
  return {
    name: 'get_sports_scores',
    description: `查赛程和赛果（比分）：北京时间某一天（或最多 ${MAX_DAYS} 天）的足球、篮球（NBA、CBA 等）、网球比赛，没开打的给开球时间，进行中的给第几分钟和比分，打完的给比分，一次查齐。问“今天 / 昨晚 / 明天有什么比赛”“某联赛赛程”“比分 / 赛果”时先用这个，不要先搜网页、也不要用技能。先查直播吧（中文队名，大约昨天到明天），更早或更晚的查 ESPN（只有主要足球联赛和 NBA）。“昨晚”的欧洲比赛在北京时间是今天凌晨，date 填昨天、end_date 填今天。查不到的再用 web_search。`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['all', 'upcoming', 'afternoon'], description: 'all全天；upcoming只看未来未开赛；afternoon北京时间12:00含至18:00不含' },
        window_minutes: { type: 'integer', minimum: 1, maximum: 360, description: 'upcoming未来分钟数，默认60' },
        date: { type: 'string', description: '北京时间日期 YYYY-MM-DD，默认今天' },
        end_date: { type: 'string', description: '可选：查到哪天（含），最多跨 3 天' },
        sport: { type: 'string', enum: ['all', 'football', 'basketball', 'tennis'], description: '用户没说哪项运动就填 all' },
        leagues: { type: 'array', items: { type: 'string' }, description: '可选：只查这些赛事，写中文名（中超、中甲、英超、欧冠、NBA、CBA……）或“五大联赛”“欧战”' },
        team: { type: 'string', description: '可选：只看某支球队，写中文队名的一部分（如 海港、阿森纳、湖人）' }
      },
      additionalProperties: false
    },
    run: (args, { signal, retrieval, progress, requestText = '', rawRequestText = '' } = {}) => getSportsScores({ ...args, ...inferSportsWindow(requestText || rawRequestText) }, { get, signal, retrieval, progress })
  };
}

/**
 * 先查：问赛程、比分的短问题，在请求模型之前就查好（像 preSearch 先搜一样，省掉一整轮）。
 * 只认得出是我们能查的项目才先查；问 CBA、网球之类的照旧走搜索。
 * @returns {object|null} get_sports_scores 的参数
 */
export function sportsPreCall(text, now = Date.now()) {
  const t = String(text ?? '').trim();
  if (t.length < 4 || t.length > 120) return null;
  if (!/赛程|赛果|比分|对阵|战报|开球|比赛|赛事|球赛|踢球|输赢|谁赢/.test(t)) return null;
  if (!/[？?]|什么|哪|几|吗|呢|查|有没有|怎么样|多少|安排|列|看/.test(t)) return null;
  if (/排球|乒乓|羽毛球|F1|赛车|台球|高尔夫|棋|田径|游泳|写|生成|做一?[份个张]|文档|表格|PPT/i.test(t)) return null;
  const today = beijingDate(now);
  const args = inferSportsWindow(t);
  const md = t.match(/(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*[日号]?/);
  if (/前天/.test(t)) args.date = shiftDate(today, -2);
  else if (/昨晚|昨夜/.test(t)) Object.assign(args, { date: shiftDate(today, -1), end_date: today });
  else if (/昨天|昨日/.test(t)) args.date = shiftDate(today, -1);
  else if (/后天/.test(t)) args.date = shiftDate(today, 2);
  else if (/明天|明日|明晚/.test(t)) args.date = shiftDate(today, 1);
  else if (/今晚|今夜/.test(t)) Object.assign(args, { date: today, end_date: shiftDate(today, 1) });
  else if (md) {
    const mm = String(md[1]).padStart(2, '0');
    const dd = String(md[2]).padStart(2, '0');
    const guess = `${today.slice(0, 4)}-${mm}-${dd}`;
    try {
      args.date = checkDate(guess);
    } catch {
      return null;
    }
  }
  const leagues = LEAGUES.filter((l) => t.includes(l.name)).map((l) => l.name);
  // ESPN 没有、直播吧有的
  for (const n of ['CBA', '中甲', '中乙']) if (t.toUpperCase().includes(n)) leagues.push(n);
  for (const g of Object.keys(GROUPS)) if (t.includes(g)) leagues.push(g);
  if (/国足|国家队/.test(t)) leagues.push('世预赛亚洲区', '国际友谊赛', '亚洲杯');
  if (leagues.length) args.leagues = [...new Set(leagues)];
  else if (/篮球|nba/i.test(t)) args.sport = 'basketball';
  else if (/网球/.test(t)) args.sport = 'tennis';
  else if (/足球|球队|英超|欧冠/.test(t)) args.sport = 'football';
  else args.sport = 'all';
  return args;
}
