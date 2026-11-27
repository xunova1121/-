/**
 * “我今天干嘛了 / 昨天聊了什么 / 这周忙了啥”：把这段时间里所有对话（包括别的对话框、别的设备上的）都列给模型，
 * 不能只看当前这段对话，也不能靠关键词搜（这种问题没有可搜的关键词，以前要追问好几次才答全）。
 * 时间按北京时间算。
 */
const DAY = 86_400_000;
const BJ = 8 * 3600_000;
const ACTIVITY = /干嘛|干了|干啥|干什么|做了|做过|做什么|忙了|忙啥|忙什么|聊了|聊过|聊什么|问了|问过|问什么|说了|说过|弄了|搞了|安排了|回顾|复盘|总结一下|都有哪些对话|哪些事/;

/** 北京时间某天 0 点 */
const dayStart = (t) => Math.floor((t + BJ) / DAY) * DAY - BJ;

/**
 * 这句话是不是在问某段时间里自己做了什么；是就返回时间范围
 * @returns {{ from: number, to: number, label: string } | null}
 */
export function reviewPeriod(text, now = Date.now()) {
  const t = String(text ?? '');
  if (t.length > 80 || !ACTIVITY.test(t)) return null;
  const today = dayStart(now);
  if (/前天/.test(t)) return { from: today - 2 * DAY, to: today - DAY, label: '前天' };
  if (/昨天|昨日|昨晚/.test(t)) return { from: today - DAY, to: today, label: '昨天' };
  if (/今天|今日|今晚|今早|上午|下午|刚才|一天/.test(t)) return { from: today, to: now + 1, label: '今天' };
  if (/这周|本周|这个星期|这一周|这礼拜/.test(t)) {
    const weekday = (new Date(now + BJ).getUTCDay() + 6) % 7; // 周一为 0
    return { from: today - weekday * DAY, to: now + 1, label: '这周' };
  }
  if (/最近|这几天|近几天|这两天/.test(t)) return { from: today - 2 * DAY, to: now + 1, label: '最近三天' };
  return null;
}

const clock = (ts) => new Date(ts + BJ).toISOString().slice(11, 16);
const date = (ts) => new Date(ts + BJ).toISOString().slice(5, 10);

/**
 * 这段时间里的所有对话，写成给模型看的一段（每段对话：标题、时间、用户说过的几句话、做出的文件）
 * @param {Array} all  所有对话（sessions.all() 的结果）
 */
export function periodBlock(all, period, { currentId = null, maxSessions = 15, perSession = 4 } = {}) {
  if (!period) return '';
  const rows = [];
  for (const s of all ?? []) {
    if (s.evaluationId) continue;
    const said = (s.messages ?? []).filter((m) => m.role === 'user' && m.ts >= period.from && m.ts < period.to && String(m.content ?? '').trim());
    if (!said.length) continue;
    const files = [...new Set((s.messages ?? []).filter((m) => m.ts >= period.from && m.ts < period.to).flatMap((m) => m.files ?? []))].slice(0, 4);
    rows.push({ s, said, files, first: said[0].ts, last: said.at(-1).ts });
  }
  if (!rows.length) return `## ${period.label}的对话\n${period.label}没有找到任何对话记录。`;
  rows.sort((a, b) => a.first - b.first);
  const shown = rows.slice(-maxSessions);
  const span = (r) => (period.label === '今天' || period.label === '昨天' || period.label === '前天' ? `${clock(r.first)}–${clock(r.last)}` : `${date(r.first)} ${clock(r.first)}`);
  const lines = shown.map((r) => {
    const asks = r.said.slice(0, perSession).map((m) => `「${String(m.content).replace(/\s+/g, ' ').slice(0, 60)}」`).join('、');
    const more = r.said.length > perSession ? ` 等 ${r.said.length} 句` : '';
    return `- ${span(r)}「${r.s.title || '新对话'}」${r.s.id === currentId ? '（就是当前这段）' : ''}（id: ${r.s.id}）：用户说了 ${asks}${more}${r.files.length ? `；做出文件：${r.files.join('、')}` : ''}`;
  });
  return `## ${period.label}的所有对话（共 ${rows.length} 段${rows.length > shown.length ? `，列出最近 ${shown.length} 段` : ''}，按时间先后；包括其他对话框和其他设备上的）
用户在问${period.label}做了什么：按这份清单把每段都概括到，按时间顺序说，不要只讲当前这段对话；要细节再用 read_conversation 读全文。
${lines.join('\n')}`;
}
