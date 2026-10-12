/**
 * 操作习惯学习：把“几点在用哪个程序”的采样汇总成习惯（只在本机）。
 *
 *   数据：每个程序的累计时长、按小时 / 星期分布；每天第一次、最后一次用电脑的时间；每天开机后先打开的程序
 *   结论（规则得出，不需要大模型）：
 *     - 通常几点开始 / 结束用电脑
 *     - 最常用的程序及占比
 *     - 某个程序集中在什么时段（“上午常用 VS Code”）
 *     - 开始工作时通常先打开什么
 *   结论会写进记忆（分类“习惯”），也用于主动问好时的建议。
 */
import { collection } from './store.js';

const kv = collection('kv');
const KEY = 'habits';
const SAMPLE_MIN = 20 / 60; // 每次采样代表约 20 秒
const SELF = /^(jarvis|贾维斯|electron)$/i;

/** 进程名 → 好认的名字 */
const FRIENDLY = {
  code: 'VS Code', 'visual studio code': 'VS Code', chrome: 'Chrome', 'google chrome': 'Chrome', msedge: 'Edge', 'microsoft edge': 'Edge',
  firefox: 'Firefox', wechat: '微信', weixin: '微信', explorer: '文件资源管理器', 'windows explorer': '文件资源管理器', finder: '访达',
  winword: 'Word', 'microsoft word': 'Word', excel: 'Excel', 'microsoft excel': 'Excel', powerpnt: 'PowerPoint', 'microsoft powerpoint': 'PowerPoint',
  dingtalk: '钉钉', feishu: '飞书', lark: '飞书', qq: 'QQ', 'windows terminal': '终端', windowsterminal: '终端', terminal: '终端', 'gnome-terminal-server': '终端', iterm2: '终端',
  safari: 'Safari', slack: 'Slack', 'microsoft teams': 'Teams', teams: 'Teams', notion: 'Notion', obsidian: 'Obsidian', wps: 'WPS', 'wps office': 'WPS'
};
export function normalizeApp(name) {
  const n = String(name || '').trim().replace(/\.exe$/i, '');
  if (!n || SELF.test(n)) return '';
  return FRIENDLY[n.toLowerCase()] ?? n.slice(0, 40);
}

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const minuteOfDay = (ts) => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
export const emptyStats = () => ({ apps: {}, days: {}, samples: 0, since: Date.now() });

/** 纯函数：把一次采样加进统计 */
export function addSample(stats, { app, ts }) {
  const name = normalizeApp(app);
  if (!name) return stats;
  const a = (stats.apps[name] ??= { minutes: 0, hours: Array(24).fill(0), weekdays: Array(7).fill(0) });
  const d = new Date(ts);
  a.minutes += SAMPLE_MIN;
  a.hours[d.getHours()] += SAMPLE_MIN;
  a.weekdays[d.getDay()] += SAMPLE_MIN;
  const k = dayKey(ts);
  const day = (stats.days[k] ??= { first: minuteOfDay(ts), last: minuteOfDay(ts), firstApp: name, weekday: d.getDay() });
  day.last = Math.max(day.last, minuteOfDay(ts));
  stats.samples++;
  // 只保留最近 60 天的每日记录
  const keys = Object.keys(stats.days);
  if (keys.length > 60) for (const old of keys.sort((x, y) => new Date(x) - new Date(y)).slice(0, keys.length - 60)) delete stats.days[old];
  return stats;
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const PERIODS = [['早上', 5, 9], ['上午', 9, 12], ['中午', 12, 14], ['下午', 14, 18], ['晚上', 18, 23], ['深夜', 23, 29]];
const periodOf = (h) => PERIODS.find(([, a, b]) => (h >= a && h < b) || (h + 24 >= a && h + 24 < b))?.[0] ?? '';

/**
 * 从统计里得出习惯（至少要有 3 天的数据才下结论）
 * @returns {{ ready: boolean, days: number, hours: number, insights: string[], top: Array<{ app, minutes, share }> }}
 */
export function insightsFrom(stats) {
  const days = Object.values(stats.days);
  const total = Object.values(stats.apps).reduce((s, a) => s + a.minutes, 0);
  const top = Object.entries(stats.apps).map(([app, a]) => ({ app, minutes: Math.round(a.minutes), share: total ? a.minutes / total : 0, hours: a.hours }))
    .sort((a, b) => b.minutes - a.minutes).slice(0, 6);
  const out = { ready: days.length >= 3, days: days.length, hours: Math.round(total / 60), top: top.map(({ app, minutes, share }) => ({ app, minutes, share })), insights: [] };
  if (!out.ready) return out;
  const workdays = days.filter((d) => d.weekday >= 1 && d.weekday <= 5);
  const base = workdays.length >= 3 ? workdays : days;
  const start = median(base.map((d) => d.first));
  const end = median(base.map((d) => d.last));
  if (start !== null) out.insights.push(`${workdays.length >= 3 ? '工作日' : ''}通常 ${hhmm(start)} 左右开始用电脑，${hhmm(end)} 左右结束`);
  if (top.length) out.insights.push(`最常用的程序：${top.slice(0, 3).map((t) => `${t.app}（${Math.round(t.share * 100)}%）`).join('、')}`);
  for (const t of top.slice(0, 3)) {
    const peak = t.hours.indexOf(Math.max(...t.hours));
    const inPeriod = t.hours.reduce((s, v, h) => s + (periodOf(h) === periodOf(peak) ? v : 0), 0);
    if (t.minutes >= 30 && inPeriod / t.minutes >= 0.5) out.insights.push(`${periodOf(peak)}主要在用 ${t.app}`);
  }
  const firsts = base.map((d) => d.firstApp);
  const counts = firsts.reduce((m, a) => m.set(a, (m.get(a) ?? 0) + 1), new Map());
  const [firstApp, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (firstApp && n / firsts.length >= 0.5) out.insights.push(`开始用电脑时通常先打开 ${firstApp}`);
  return out;
}

/** 此刻的建议（主动问好用）：这个时段你通常在用什么 */
export function hintFor(stats, now = new Date()) {
  const r = insightsFrom(stats);
  if (!r.ready) return [];
  const h = now.getHours();
  const t = Object.entries(stats.apps).map(([app, a]) => ({ app, v: a.hours[h], total: a.hours.reduce((x, y) => x + y, 0) })).sort((a, b) => b.v - a.v)[0];
  const hourTotal = Object.values(stats.apps).reduce((s, a) => s + a.hours[h], 0);
  if (!t || !hourTotal || t.v / hourTotal < 0.4 || t.v < 10) return [];
  return [`这个时间你通常会用 ${t.app}，需要的话我帮你打开`];
}

// ---------------------------------------------------------------- 存取（内存里攒着，每分钟写一次盘）
let cache = null;
let dirty = false;
export async function load() {
  cache ??= (await kv.get(KEY))?.stats ?? emptyStats();
  return cache;
}
export async function record(sample) {
  addSample(await load(), sample);
  dirty = true;
}
export async function flush() {
  if (!dirty || !cache) return;
  dirty = false;
  await kv.put({ id: KEY, stats: cache });
}
export async function clear() {
  cache = emptyStats();
  dirty = false;
  await kv.delete(KEY);
}
