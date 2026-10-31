import { sportsWindow, inSportsWindow, inferSportsWindow } from './sportsWindow.js';
import { throwControl } from '../core/networkRequest.js';
import { fetchZhibo8, zhibo8Result } from './sportsZhibo8.js';
import { selectedTeam } from './sportsFollowup.js';
import { sportsSnapshot } from './sportsSnapshot.js';
import { fetchSchedulePage, schedulePageResult, clearScheduleCache } from './sportsSchedulePage.js';
import { lookupIntent } from './lookup/intent.js';
import { sportsNewsIntent } from './newsIntent.js';
/**
 * 赛程和赛果：按北京时间的某一天，把各联赛的比赛（没开打的给开球时间，打完的给比分）一次查齐。
 * 不走搜索引擎（搜索摘要零散、经常漏场次），直接读比分接口（不用密钥），手机、电脑、服务器都能用：
 *   1. 直播吧（国内连得上，中文队名，只有大约昨天到明天，见 sportsZhibo8.js）
 *   2. 直播吧公开赛程页（计划对阵，不冒充实时比分）；再失败交给统一搜索自救。
 *
 * 日期、窗口一律按北京时间；不能把截图里的半场或历史比分当实时数据。
 *
 * 覆盖不到的（CBA、中甲、网球、排球、电竞……）在结果里写明，让模型用 web_search 补，不把“没查”说成“没有比赛”。
 */

/** 要查的赛事：旧联赛代码（仅作名称别名） → 中文名。兼容旧会话的联赛别名，不作为上游地址 */
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

/** 用户说的赛事（中文名、旧联赛代码（仅作名称别名）、“五大联赛”这类分组）→ 要查的赛事 */
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
  if (sport === 'tennis') return []; // 网球由直播吧项目字段处理
  const s = { football: 'soccer', soccer: 'soccer', basketball: 'basketball' }[sport];
  return s ? LEAGUES.filter((l) => l.sport === s) : LEAGUES;
}

/** 兼容原缓存清理入口；比分缓存仍由直播吧模块管理。 */
export const clearScoresCache = clearScheduleCache;

/**
 * @param {{ date?: string, end_date?: string, sport?: string, leagues?: string[]|string, team?: string }} args
 * @param {{ get: (url: string, init?: object) => Promise<Response>, signal?: AbortSignal, retrieval?: object, now?: number, progress?: (m: string) => void }} o
 */
export async function getSportsScores(args = {}, { get, signal, retrieval, now = Date.now(), progress, onScores, refresh = false } = {}) {
  let from = args.date ? checkDate(args.date) : beijingDate(now);
  const window = sportsWindow(args, now);
  let to = args.end_date ? checkDate(args.end_date) : from;
  if (['around', 'forward_live'].includes(window.period)) {
    // 当前窗口跨午夜时同时读前后两天；不能先按“今天”裁掉昨晚仍在进行的比赛。
    from = beijingDate(now - window.minutes * 60_000);
    to = beijingDate(now + window.minutes * 60_000);
  }
  if (window.period === 'upcoming' && !args.end_date && from === beijingDate(now)) to = beijingDate(now + window.minutes * 60_000);
  if (to < from) throw invalid('结束日期不能早于开始日期');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_DAYS) throw invalid(`一次最多查 ${MAX_DAYS} 天`);
  const selected = Array.isArray(args.teams) ? args.teams.filter(t => typeof t === 'string' && t.trim()).slice(0, 12) : [];
  if (args.teams && (!Array.isArray(args.teams) || args.teams.length > 12 || selected.length !== args.teams.length)) throw invalid('teams需为最多12个非空队名');
  const asked = pickLeagues(args);
  const named = (Array.isArray(args.leagues) ? args.leagues : args.leagues ? [args.leagues] : []).map((x) => String(x).trim()).filter(Boolean);
  // 整次查询算一次读取（一个数据接口，不按赛事个数扣）
  retrieval?.consume('read');
  // 先问直播吧：国内连得上；要查的每一天它都有就直接用
  let partial = null;
  let primary = null;
  const deliver = (text, groups, notice = '') => {
    const missing = selected.filter(name => !groups.some(g => g.events.some(e => selectedTeam(`${e.home.name} ${e.away.name}`, [name]))));
    const scope = selected.length ? `本轮仅核对指定的${selected.length}个球队线索，不包含其他比赛。${missing.length ? '未匹配到：' + missing.join('、') + '；不能用其他场次补齐。' : ''}` : '';
    onScores?.(sportsSnapshot({ args, groups, now, window, notice: [scope, notice].filter(Boolean).join('；') }));
    return [scope, text].filter(Boolean).join('\n');
  };
  try {
    progress?.('正在查直播吧的赛程和比分');
    const list = await fetchZhibo8({ get, signal, refresh });
    primary = zhibo8Result(selected.length ? list.filter(e => selectedTeam(`${e.home_team} ${e.visit_team}`, selected)) : list, { from, to, today: beijingDate(now), sports: zhibo8Sports(args, asked, named), team: args.team, focus: named, clock: `${beijingDate(now)} ${beijingClock(now)}`, window });
  } catch (error) {
    throwControl(error, signal);
  }
  if (primary?.covered) return deliver(primary.text, [{ source: '直播吧', events: primary.events }]);
  if (primary?.count) partial = primary;
  if (!asked.length) {
    if (partial) return deliver(partial.text, [{ source: '直播吧', events: partial.events }]);
    throw invalid(`没认出要查的赛事。能查：${LEAGUES.map((l) => l.name).join('、')}；查不了：${NOT_COVERED}（用 web_search）`);
  }
  try {
    const page = await fetchSchedulePage({ get, signal, refresh });
    const result = schedulePageResult(selected.length ? page.filter(e => selectedTeam(`${e.home.name} ${e.away.name}`, selected)) : page, { from, to, sports: zhibo8Sports(args, asked, named),
      team: args.team, focus: named.flatMap(name => GROUPS[name] ? LEAGUES.filter(l => GROUPS[name].includes(l.code)).map(l => l.name) : [LEAGUES.find(l => l.code === name)?.name || name]), window, now });
    if (!result.covered && !result.count && !partial) throw Object.assign(new Error('赛程页未覆盖所查日期'), { code: 'SPORTS_PAGE_EMPTY' });
    const notice = '比分接口未取得完整结果，赛程页仅提供计划对阵，实时状态和比分未核实';
    const text = partial ? partial.text + '\n\n' + result.text + '\n两份来源可能重叠，不能把两份场数直接相加。' : result.text;
    return deliver(text, [...(partial ? [{ source: '直播吧', events: partial.events }] : []), { source: '直播吧赛程页', events: result.events }], notice);
  } catch (error) {
    throwControl(error, signal);
    if (partial) return deliver(partial.text + '\n缺失日期的赛程页也未取得，需用 web_search 补查。', [{ source: '直播吧', events: partial.events }], '仅展示已取得的部分日期');
    throw Object.assign(new Error(`直播吧比分接口及赛程页未取得所查范围；用 web_search 查询“${from} ${named.join(' ') || '足球'} 赛程 比分”。`), { code: 'SPORTS_UNAVAILABLE', kind: 'network' });
  }
}

/** 直播吧按项目筛：用户点名的联赛决定项目（含CBA、中甲） */
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
    description: `查赛程和赛果（比分）：北京时间某一天（或最多 ${MAX_DAYS} 天）的足球、篮球（NBA、CBA 等）、网球比赛，没开打的给开球时间，进行中的给第几分钟和比分，打完的给比分，一次查齐。问“今天 / 昨晚 / 明天有什么比赛”“某联赛赛程”“比分 / 赛果”时先用这个，不要先搜网页、也不要用技能。先查直播吧（中文队名，大约昨天到明天），接口失败或日期未覆盖时读直播吧公开赛程页；页面不含可核实实时比分时明确说明。“昨晚”的欧洲比赛在北京时间是今天凌晨，date 填昨天、end_date 填今天。查不到的再用 web_search。界面卡片不能替代文字答复：回答仍要列出主要对阵、北京时间、状态及比分，方便单独阅读和语音朗读。`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['all', 'upcoming', 'remaining', 'afternoon', 'around', 'forward_live'], description: 'forward_live当前起120分钟，只含进行中/中场及未开赛；普通今天足球/足彩赛程用forward_live；明确前后或现在有什么球用around前后各120分钟；all全天；remaining今天剩余未开赛不限60分钟；upcoming未来分钟窗口；afternoon12:00含至18:00不含' },
        window_minutes: { type: 'integer', minimum: 1, maximum: 360, description: 'around前后各多少分钟，默认120；upcoming未来分钟数，默认60' },
        date: { type: 'string', description: '北京时间日期 YYYY-MM-DD，默认今天' },
        end_date: { type: 'string', description: '可选：查到哪天（含），最多跨 3 天' },
        sport: { type: 'string', enum: ['all', 'football', 'basketball', 'tennis'], description: '用户没说哪项运动就填 all' },
        leagues: { type: 'array', items: { type: 'string' }, description: '可选：只查这些赛事，写中文名（中超、中甲、英超、欧冠、NBA、CBA……）或“五大联赛”“欧战”' },
        teams: { type: 'array', maxItems: 12, items: { type: 'string' }, description: '前文或截图指定多场时填各场已识别的队名，最多12个；不是查全部比赛。名称别名须有依据，未匹配的明确说明。' },
        team: { type: 'string', description: '可选：只看某支球队，写中文队名的一部分（如 海港、阿森纳、湖人）' }
      },
      additionalProperties: false
    },
    run: async (args, { signal, retrieval, progress, requestText = '', rawRequestText = '' } = {}) => {
      if (retrieval?.sportsScope) {
        if (!args?.team && !args?.teams?.length && retrieval.sportsScope.teams.length) args = { ...args, teams: retrieval.sportsScope.teams, period: 'all' };
        if (!args?.team && !args?.teams?.length) throw invalid('请先从前文或原图识别用户选定的对阵，用teams查询；不能用全部赛程代替。');
      }
      if (sportsNewsIntent(requestText || rawRequestText)) throw Object.assign(new Error('用户要体育新闻资讯，不是比分赛程；请用web_search查报道，不能用比分替代。'), { code: 'SPORTS_NEWS_NOT_SCORES' });
      const text = requestText || rawRequestText;
      const intent = retrieval?.intentRequest === text && retrieval.intent ? retrieval.intent : lookupIntent(text);
      const policy = intent.kind === 'sports_live' && intent.params.period === 'forward_live' ? { period: 'forward_live', window_minutes: intent.params.window_minutes, sport: intent.params.sport } : inferSportsWindow(text);
      return getSportsScores({ ...args, ...(retrieval?.sportsScope ? {} : policy) }, { get, signal, retrieval, progress, onScores: ctx.onSportsScores });
    }
  };
}

/**
 * 先查：问赛程、比分的短问题，在请求模型之前就查好（像 preSearch 先搜一样，省掉一整轮）。
 * 只认得出是我们能查的项目才先查；问 CBA、网球之类的照旧走搜索。
 * @returns {object|null} get_sports_scores 的参数
 */
export function sportsPreCall(text, now = Date.now()) {
  const t = String(text ?? '').trim();
  if (sportsNewsIntent(t)) return null;
  if (t.length < 4 || t.length > 120) return null;
  if (!/赛程|赛果|比分|对阵|战报|开球|比赛|赛事|球赛|踢球|输赢|谁赢|现在有什么球/.test(t)) return null;
  if (!/[？?]|什么|哪|几|吗|呢|查|有没有|怎么样|多少|安排|列|看|足彩赛程|竞彩足球赛程|前后/.test(t)) return null;
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
  // 国内项目和联赛别名
  for (const n of ['CBA', '中甲', '中乙']) if (t.toUpperCase().includes(n)) leagues.push(n);
  for (const g of Object.keys(GROUPS)) if (t.includes(g)) leagues.push(g);
  if (/国足|国家队/.test(t)) leagues.push('世预赛亚洲区', '国际友谊赛', '亚洲杯');
  if (leagues.length) args.leagues = [...new Set(leagues)];
  else if (/篮球|nba/i.test(t)) args.sport = 'basketball';
  else if (/网球/.test(t)) args.sport = 'tennis';
  else if (/足球|足彩|竞彩|球队|英超|欧冠|现在有什么球/.test(t)) args.sport = 'football';
  else args.sport = 'all';
  return args;
}
