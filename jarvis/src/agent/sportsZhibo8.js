import { inSportsWindow, beijingTimestamp } from './sportsWindow.js';
import { httpError } from '../core/networkRequest.js';
import { withWebDeadline } from './retrievalBudget.js';
/**
 * 赛程比分的国内来源：直播吧的比分列表（bifen4pc.qiumibao.com，不用密钥）。
 * 国内服务器连得上（ESPN 连不上）；中文队名、北京时间、比分、半场、第几分钟都有。
 * 局限（2026-10-25 在用户服务器上实测）：
 *   - 只是“当前”列表：大约昨天到明天，明天的只排进了少数几场；不能按任意日期查
 *   - 没有联赛名，只有联赛编号：同一编号放在一起，不按队名猜联赛级别
 * state：1 未赛、2 进行中、3 完赛、4 延期、6 取消、7 待定
 */
export const ZHIBO8_URL = 'https://bifen4pc.qiumibao.com/json/list.htm';
const STATE = { 1: '未开赛', 2: '进行中', 3: '完场', 4: '延期', 6: '取消', 7: '待定' };
const SPORT = { football: '足球', basketball: '篮球', tennis: '网球', snooker: '斯诺克', game: '电竞', other: '其他' };
/** 特殊状态只用于分类统计，不能再拿它隐藏比赛或猜联赛级别。 */
const SPECIAL = new Set(['4', '6', '7']);
const TIMEOUT_MS = 6000;
/** 列表随比赛进行变化：缓存 30 秒（只一条） */
const CACHE_MS = 30_000;
let cached = null;
export const clearZhibo8Cache = () => {
  cached = null;
};

/** 取直播吧的比分列表 */
export async function fetchZhibo8({ get, signal, refresh = false }) {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  const data = await withWebDeadline(
    async (s) => {
      const response = await get(ZHIBO8_URL, { signal: s });
      if (!response.ok) throw httpError(response.status, '', '直播吧');
      return response.json();
    },
    { signal, timeoutMs: TIMEOUT_MS }
  );
  if (!Array.isArray(data?.list)) throw Object.assign(new Error('直播吧返回的格式不认识'), { kind: 'api', code: 'BAD_FORMAT' });
  cached = { at: Date.now(), list: data.list };
  return data.list;
}

/** 一场 → 我们要的几项（主队在前：rightishome 为 1 时右边那队是主队） */
export function normalizeZhibo8(m) {
  const swap = String(m.rightishome) === '1';
  const left = { name: m.home_team, score: m.home_score };
  const right = { name: m.visit_team, score: m.visit_score };
  const [home, away] = swap ? [right, left] : [left, right];
  return {
    id: String(m.id ?? ''),
    sport: String(m.type || 'other'),
    leagueId: String(m.leagueid ?? ''),
    jingcai: m.is_jingcai === true || String(m.is_jingcai) === '1',
    date: String(m.sdate || String(m.start || '').slice(0, 10)),
    time: String(m.time || String(m.start || '').slice(11, 16)),
    home,
    away,
    state: String(m.state ?? ''),
    period: String(m.period_cn || '').replace(/\s+/g, ' ').trim(),
    half: String(m.half_score || '').replace(/[（）()半:：\s]/g, '')
  };
}

function lineOf(e) {
  const started = e.state === '2' || e.state === '3';
  const scoreKnown = [e.home.score, e.away.score].every(value => value !== null && value !== undefined && /^\d+$/.test(String(value)));
  const score = started && scoreKnown ? `${e.home.score}-${e.away.score}` : 'vs';
  const status = e.state === '2' ? `进行中 ${e.period}`.trim() : STATE[e.state] || `状态未知（原状态${e.state || '空'}${e.period ? '，来源文字' + e.period : ''}）`;
  const half = e.half && e.state === '3' ? `（半场 ${e.half}）` : '';
  return `- ${e.time} ${status}：${e.home.name} ${score} ${e.away.name}${half}`;
}

const WEEK = '日一二三四五六';
const weekday = (date) => `周${WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;
const datesBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

/**
 * 按北京日期、项目、球队筛选并整理成给模型看的文字
 * @returns {{ covered: boolean, text: string, count: number }} covered：要查的每一天列表里都有
 */
export function zhibo8Result(list, { from, to, today, sports = null, team = '', focus = [], clock = '', window = null }) {
  const all = list.map(normalizeZhibo8);
  const days = datesBetween(from, to);
  const have = new Set(all.map((e) => e.date));
  const covered = days.every((d) => have.has(d));
  const q = String(team || '').trim().toLowerCase();
  const picked = all.filter((e) => days.includes(e.date) && (!sports || sports.includes(e.sport)) && (!q || `${e.home.name} ${e.away.name}`.toLowerCase().includes(q)));
  const shown = picked.filter((e) => inSportsWindow(beijingTimestamp(e.date, e.time), e.state, window));
  const quiet = shown.filter(e => SPECIAL.has(e.state)).length;
  const unknown = shown.filter(e => !STATE[e.state]).length;
  const order = Object.keys(SPORT);
  shown.sort((a, b) => (['around', 'forward_live'].includes(window?.period) ? Number(b.state === '2') - Number(a.state === '2') : 0) || (window && window.period !== 'all' ? beijingTimestamp(a.date, a.time) - beijingTimestamp(b.date, b.time) : a.date.localeCompare(b.date) || order.indexOf(a.sport) - order.indexOf(b.sport) || a.leagueId.localeCompare(b.leagueId) || a.time.localeCompare(b.time)));
  const lines = [`北京时间 ${from}（${weekday(from)}）${to !== from ? ` 至 ${to}（${weekday(to)}）` : ''}的赛程和比分，来源直播吧（zhibo8.com），查询于北京时间 ${clock}。时间都是北京时间，前面是主队。`];
  lines.push(`本来源本次筛选共${shown.length}场，${['around', 'forward_live'].includes(window?.period) ? '本窗口只显示进行中和未开赛' : '延期/取消/待定和未知状态也保留明细'}；不代表所有联赛完整覆盖。`);
  if (window?.label) lines.push('时间筛选：' + window.label + '；不代表全天完整赛程。');
  if (!shown.length) lines.push('\n这段时间列表里没有符合条件的比赛。');
  let day = '';
  let sport = '';
  let league = '';
  for (const e of shown) {
    if (e.date !== day) {
      day = e.date;
      sport = league = '';
      if (from !== to) lines.push(`\n# ${day}（${weekday(day)}）`);
    }
    if (e.sport !== sport) {
      sport = e.sport;
      league = '';
      lines.push(`\n## ${SPORT[sport] || sport}`);
    }
    if (e.leagueId !== league) {
      league = e.leagueId;
      lines.push(`### 赛事编号 ${league}`);
    }
    lines.push(lineOf(e));
  }
  if (quiet) lines.push(`\n分类统计：另有 ${quiet} 场延期、取消或待定，已包含在上方逐场明细和总场数内，不推断联赛级别。`);
  if (unknown) lines.push(`\n另有${unknown}场来源状态未知，已保留原状态码和文字，不按开球时间猜成未开赛、延期或完场。`);
  lines.push('\n说明：这个列表不带联赛名，同一“赛事编号”是同一个联赛——不能从队名推断联赛或级别；未返回的联赛名明确说未提供，用户确需时再核对官方赛程。不要把赛事编号当已核实的联赛名。');
  if (focus.length) lines.push(`用户问的是：${focus.join('、')}。只挑这些联赛的比赛回答；列表里没有就说直播吧当前列表里没有，需要时用 web_search 再查。`);
  if (days.some((d) => d > today)) lines.push('明天及以后的比赛这里只排进了少数几场，不全；用户要完整赛程时用 web_search 补。');
  if (!covered) lines.push(`列表只覆盖大约昨天到明天，${days.filter((d) => !have.has(d)).join('、')} 没有数据。`);
  lines.push('进行中的比分会变；比分以这里为准，未开赛的不要编比分。');
  lines.push('本列表未提供可核实的竞彩场次编号、停售时间及赔率；只展示普通赛程，不把赛事ID或is_jingcai标记编成竞彩编号。');
  const events = shown.map(e => ({ ...e, time: beijingTimestamp(e.date, e.time), state: ({ '1': 'pre', '2': 'in', '3': 'post' })[e.state] || 'unknown', status: e.state === '2' ? `进行中 ${e.period}`.trim() : STATE[e.state] || '状态未知' }));
  return { covered, text: lines.join('\n'), count: shown.length, events };
}
