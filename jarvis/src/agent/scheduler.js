/**
 * 定时任务：到点让未央自动做一件事（“每个工作日 9 点总结今天的日程”“每周五 17:30 写周报”）。
 *
 *   - 在应用运行时执行：桌面版关窗后在托盘里继续运行；网页版需要页面开着
 *   - 错过的（电脑关机、应用没开）：12 小时内的补跑一次，更早的直接排到下一次
 *   - 每次运行的结果保存为一段对话（“⏰ 任务名”），并发通知（模型判断“这次无需通知”时不发）
 *   - 无人值守时，需要确认的操作（写文件、运行命令……）默认拒绝；任务可以单独设为“允许无人值守操作”
 *   - 开始执行前先排好下一次（claim）：中途崩溃重启后不会把同一次再跑一遍；一次性任务允许崩溃后重试一次
 *   - 连续失败 3 次自动停用，等用户检查后重新启用
 */
import { collection, uid } from './store.js';

const kv = collection('kv');
const KEY = 'schedules';
const MIN = 60_000;
const CATCH_UP = 12 * 3600_000;
export const MAX_FAILS = 3;
const MAX_ONCE_ATTEMPTS = 2; // 一次性任务：第一次中途崩溃后允许再试一次
export const PAUSED_STATUS = `连续失败 ${MAX_FAILS} 次，已暂停，请检查后重新启用`;
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 下一次运行时间（毫秒时间戳）；仅一次且已过期返回 null
 * @param {{ kind: 'daily'|'workdays'|'weekly'|'once'|'interval', time?: string, weekday?: number, at?: number, everyMinutes?: number }} s
 */
export function nextRun(s, from = Date.now()) {
  if (s.kind === 'once') return s.at > from ? s.at : null;
  if (s.kind === 'interval') {
    const step = Math.max(5, Number(s.everyMinutes) || 60) * MIN;
    const base = s.lastRun ?? s.createdAt ?? from;
    let t = base + step;
    if (t <= from) t = from + step - ((from - base) % step);
    return t;
  }
  const [hh, mm] = String(s.time || '09:00').split(':').map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(hh, mm);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
    if (c.getTime() <= from) continue;
    const wd = c.getDay();
    if (s.kind === 'daily') return c.getTime();
    if (s.kind === 'workdays' && wd >= 1 && wd <= 5) return c.getTime();
    if (s.kind === 'weekly' && wd === Number(s.weekday ?? 1)) return c.getTime();
  }
  return null;
}

/** 人能读懂的时间描述 */
export function describe(s) {
  if (s.kind === 'once') return `仅一次 · ${new Date(s.at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  if (s.kind === 'interval') return `每 ${s.everyMinutes} 分钟`;
  if (s.kind === 'daily') return `每天 ${s.time}`;
  if (s.kind === 'workdays') return `工作日 ${s.time}`;
  return `每周${WEEKDAYS[s.weekday ?? 1]} ${s.time}`;
}

/**
 * 解析口语化的时间：每天 9:00 / 每天早上9点 / 工作日 18:30 / 每周五 17:30 / 每 30 分钟 / 每小时 / 明天 8 点 / 2026-10-20 15:00 / 30 分钟后
 * @returns {{ kind, time?, weekday?, at?, everyMinutes? }}
 */
export function parseWhen(text, from = Date.now()) {
  const t = String(text || '').replace(/\s+/g, '').replace(/：/g, ':');
  let m;
  if ((m = t.match(/每(\d+)分钟/))) return { kind: 'interval', everyMinutes: Math.max(5, Number(m[1])) };
  if ((m = t.match(/每(\d+)?个?小时/))) return { kind: 'interval', everyMinutes: 60 * Number(m[1] || 1) };
  if ((m = t.match(/^(\d+)分钟(后|以后)/))) return { kind: 'once', at: from + Number(m[1]) * MIN };
  if ((m = t.match(/^(\d+)(个)?小时(后|以后)/))) return { kind: 'once', at: from + Number(m[1]) * 60 * MIN };
  if ((m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/))) {
    const time = clockOf(t.slice(m.index + m[0].length)) || '09:00';
    const [hh, mm] = time.split(':').map(Number);
    return { kind: 'once', at: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm).getTime() };
  }
  if (/^(今天|明天|后天)/.test(t)) {
    const add = { 今天: 0, 明天: 1, 后天: 2 }[t.slice(0, 2)];
    const time = clockOf(t.slice(2)) || '09:00';
    const [hh, mm] = time.split(':').map(Number);
    const d = new Date(from);
    return { kind: 'once', at: new Date(d.getFullYear(), d.getMonth(), d.getDate() + add, hh, mm).getTime() };
  }
  if ((m = t.match(/每(?:周|星期|礼拜)([一二三四五六日天])/))) return { kind: 'weekly', weekday: '日一二三四五六天'.indexOf(m[1]) % 7, time: clockOf(t.slice(m.index + m[0].length)) || '09:00' };
  if (/工作日|周一到周五|每个工作日/.test(t)) return { kind: 'workdays', time: clockOf(t.replace(/工作日|周一到周五|每个工作日/, '')) || '09:00' };
  if (/每天|每日|天天/.test(t)) return { kind: 'daily', time: clockOf(t.replace(/每天|每日|天天/, '')) || '09:00' };
  throw new Error(`看不懂这个时间：“${text}”。可以说：每天 9:00、工作日 18:30、每周五 17:30、每 30 分钟、明天 8 点、2026-10-20 15:00`);
}

/** 从一段文字里读出钟点（“早上9点”“17:30”“下午3点半”） */
export function clockOf(text) {
  const m = String(text || '').replace(/\s+/g, '').replace(/：/g, ':').match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?(\d{1,2})(?:[:点时](\d{1,2})?(半)?)?/);
  if (!m) return null;
  let h = Number(m[2]);
  const mm = m[4] ? 30 : Number(m[3] || 0);
  if (/下午|傍晚|晚上/.test(m[1] || '') && h < 12) h += 12;
  if (m[1] === '中午' && h < 11) h += 12;
  if (h > 23 || mm > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 存取
export async function list() {
  return (await kv.get(KEY))?.items ?? [];
}
async function saveAll(items) {
  await kv.put({ id: KEY, items });
}

export async function upsert(input) {
  const items = await list();
  const old = items.find((x) => x.id === input.id);
  const s = {
    id: input.id || uid('sch'),
    title: String(input.title || '').trim().slice(0, 40) || '定时任务',
    prompt: String(input.prompt || '').trim(),
    kind: input.kind,
    time: input.time,
    weekday: input.weekday,
    at: input.at,
    everyMinutes: input.everyMinutes,
    enabled: input.enabled !== false,
    unattended: Boolean(input.unattended),
    createdAt: old?.createdAt ?? Date.now(),
    lastRun: old?.lastRun ?? null,
    lastStatus: old?.lastStatus ?? null,
    lastSession: old?.lastSession ?? null,
    runs: old?.runs ?? 0,
    // 从停用改回启用：连续失败重新计数
    fails: old && !old.enabled && input.enabled !== false ? 0 : old?.fails ?? 0,
    attempts: 0
  };
  if (!s.prompt) throw new Error('请写明要让未央做什么');
  if (!['daily', 'workdays', 'weekly', 'once', 'interval'].includes(s.kind)) throw new Error('时间类型不对');
  s.nextRun = nextRun(s);
  if (s.kind === 'once' && !s.nextRun && !old) throw new Error('这个时间已经过去了');
  await saveAll(old ? items.map((x) => (x.id === s.id ? s : x)) : [...items, s]);
  return s;
}

export async function remove(id) {
  await saveAll((await list()).filter((x) => x.id !== id));
}

export async function setEnabled(id, enabled) {
  const items = await list();
  const s = items.find((x) => x.id === id);
  if (!s) return;
  s.enabled = enabled;
  if (enabled) Object.assign(s, { fails: 0, attempts: 0 }); // 用户重新启用：连续失败重新计数
  s.nextRun = enabled ? nextRun({ ...s, lastRun: s.kind === 'interval' ? Date.now() : s.lastRun }) : null;
  await saveAll(items);
}

/**
 * 开始执行前调用：周期任务先把下一次排好并保存，这样中途崩溃重启后不会把同一次再跑一遍；
 * 一次性任务的时间不动，只记尝试次数（崩溃后允许再试一次，见 due()）
 */
export async function claim(id, at = Date.now()) {
  const items = await list();
  const s = items.find((x) => x.id === id);
  if (!s) return null;
  if (s.kind === 'once') s.attempts = (s.attempts ?? 0) + 1;
  else s.nextRun = nextRun({ ...s, lastRun: s.kind === 'interval' ? at : s.lastRun }, at);
  await saveAll(items);
  return s;
}

/**
 * 记录一次运行的结果并排下一次。
 * quiet：模型判断这次按任务要求无需通知用户（算成功）。
 * 连续失败 MAX_FAILS 次自动停用，返回值带 paused: true，由调用方通知用户。
 */
export async function recordRun(id, { ok, quiet = false, session, at = Date.now(), note = '' }) {
  const items = await list();
  const s = items.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, {
    lastRun: at,
    lastStatus: !ok ? `失败：${note}`.slice(0, 120) : quiet ? 'quiet' : 'ok',
    lastSession: session ?? s.lastSession,
    runs: (s.runs ?? 0) + 1,
    fails: ok ? 0 : (s.fails ?? 0) + 1,
    attempts: 0
  });
  s.nextRun = nextRun(s, at);
  if (s.kind === 'once') s.enabled = false;
  let paused = false;
  if (!ok && s.enabled && s.fails >= MAX_FAILS) {
    Object.assign(s, { enabled: false, nextRun: null, lastStatus: PAUSED_STATUS });
    paused = true;
  }
  await saveAll(items);
  return { ...s, paused };
}

/**
 * 找出该运行的任务。错过太久（> 12 小时）的不补跑，直接排到下一次。
 * @returns {Promise<object[]>}
 */
export async function due(at = Date.now()) {
  const items = await list();
  const run = [];
  let changed = false;
  for (const s of items) {
    if (!s.enabled || !s.nextRun || s.nextRun > at) continue;
    // 一次性任务已经两次开始了都没跑完（中途崩溃 / 关闭）：不再重试
    if (s.kind === 'once' && (s.attempts ?? 0) >= MAX_ONCE_ATTEMPTS) {
      Object.assign(s, { enabled: false, nextRun: null, lastStatus: '失败：中途中断两次，已停用' });
      changed = true;
      continue;
    }
    if (at - s.nextRun > CATCH_UP) {
      s.nextRun = nextRun(s, at);
      if (s.kind === 'once') { s.enabled = false; s.lastStatus = '错过（应用当时没有运行）'; }
      changed = true;
      continue;
    }
    run.push(s);
  }
  if (changed) await saveAll(items);
  return run;
}
