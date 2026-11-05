/**
 * 数字定案（用户 2026-11-05：问“南京一共几条地铁、第一是谁”，读到的几篇原文各给一个数——611、757、556.8 公里——
 * 未央正文用一个、表格用另一个，前后打架）。几个来源对同一指标给的数不同时，按固定顺序定一个主数字：
 *   1. 口径先对上问题（问“地铁”就优先地铁口径；口径不同的不硬比，写明差在哪）
 *   2. 来源等级：官方统计/政府公告 > 权威媒体 > 门户/行业媒体 > 百科/自媒体
 *   3. 同等级取截至日期最新的
 *   4. 再看几个独立来源说法是否一致
 * 其余数字不算“错”，写明是口径、时间还是来源等级不同。交付前核对回答只用定案的主数字。
 * 只做确定性比较，不调用模型、不联网。
 */
const TIER_RULES = [
  [1, /\.gov\.cn|gov\.cn\/|政府|国务院|统计局|交通运输部|发改委|工信部|财政部|人民银行|证监会|部官网|官方公告|官方发布|官网|公告|年报|统计公报|运营数据速报/i],
  [2, /xinhuanet|news\.cn|people\.com\.cn|cctv|cntv|chinanews|新华社|新华网|人民日报|人民网|央视|中新社|中新网|光明日报|经济日报|中国日报/i],
  [4, /baike|wikipedia|百科|百家号|baijiahao|知乎|zhihu|抖音|douyin|微博|weibo|toutiao|头条号|自媒体|博客|blog|贴吧|小红书/i],
  [3, /./]
];
export const TIER_NAMES = { 1: '官方统计或公告', 2: '权威媒体', 3: '门户或行业媒体', 4: '百科或自媒体' };

/** 来源等级：看来源名和网址 */
export function sourceTier(source = '', url = '') {
  const text = `${source} ${url}`;
  return TIER_RULES.find(([, re]) => re.test(text))[0];
}

/** 截至日期 → 可比较的数（年月日）；认不出返回 0 */
export function dateRank(text = '') {
  const t = String(text);
  const m = t.match(/(\d{4})\s*[年./-]\s*(\d{1,2})?(?:\s*[月./-]\s*(\d{1,2}))?/);
  if (!m) return 0;
  const end = /年末|年底|全年/.test(t) ? 12 : 0;
  return Number(m[1]) * 10000 + Number(m[2] || end || 6) * 100 + Number(m[3] || (end ? 31 : 15));
}

/** 问题里的口径词（地铁 / 城市轨道交通 / 市域 / 运营 / 在建 …），用来挑口径对得上的数 */
const SCOPE_WORDS = ['地铁', '城市轨道交通', '轨道交通', '市域', '有轨电车', '运营', '在建', '规划', '常住', '户籍', '全口径', '规模以上', '名义', '实际', '含', '不含'];
const scopeScore = (scope, question) => SCOPE_WORDS.filter(w => String(question).includes(w) && String(scope).includes(w)).length - SCOPE_WORDS.filter(w => !String(question).includes(w) && String(scope).includes(w) && /在建|规划|含/.test(w)).length;

const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim();
const close = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.005;

/**
 * @param {Array<{subject:string,metric:string,value:number,unit?:string,as_of?:string,scope?:string,source?:string,url?:string}>} claims
 * @param {{ question?: string }} o
 */
export function reconcileNumbers(claims = [], { question = '' } = {}) {
  const list = (Array.isArray(claims) ? claims : []).slice(0, 40).map((c, i) => ({
    i, subject: norm(c.subject).slice(0, 40), metric: norm(c.metric).slice(0, 40), value: Number(c.value), unit: norm(c.unit).slice(0, 12),
    asOf: String(c.as_of ?? c.asOf ?? '').slice(0, 30), scope: String(c.scope ?? '').slice(0, 60), source: String(c.source ?? '').slice(0, 80), url: String(c.url ?? '').slice(0, 300)
  })).filter(c => c.subject && c.metric && Number.isFinite(c.value));
  const groups = new Map();
  for (const c of list) {
    const key = `${c.subject}|${c.metric}|${c.unit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, tier: sourceTier(c.source, c.url), date: dateRank(c.asOf), fit: scopeScore(`${c.scope} ${c.metric}`, question) });
  }
  return [...groups.values()].map(rows => {
    const agree = (r) => rows.filter(o => close(o.value, r.value)).length;
    const ranked = [...rows].sort((a, b) => b.fit - a.fit || a.tier - b.tier || b.date - a.date || agree(b) - agree(a) || a.i - b.i);
    const chosen = ranked[0];
    const why = (r) => {
      if (close(r.value, chosen.value)) return '与定案一致';
      const parts = [];
      if (norm(r.scope) !== norm(chosen.scope) && (r.scope || chosen.scope)) parts.push(`口径不同（${r.scope || '未写口径'}）`);
      if (r.date && chosen.date && r.date < chosen.date) parts.push(`时间较早（${r.asOf}）`);
      if (r.tier > chosen.tier) parts.push(`来源等级较低（${TIER_NAMES[r.tier]}）`);
      if (!parts.length) parts.push(agree(r) < agree(chosen) ? '与多数来源不一致' : '同等级、同时间来源说法不同，需在回答里并列说明');
      return parts.join('，');
    };
    const conflict = rows.some(r => !close(r.value, chosen.value));
    return {
      subject: chosen.subject, metric: chosen.metric, unit: chosen.unit, conflict,
      chosen: { value: chosen.value, as_of: chosen.asOf, scope: chosen.scope, source: chosen.source, url: chosen.url, tier: TIER_NAMES[chosen.tier],
        reason: [chosen.fit > 0 && '口径与问题一致', `${TIER_NAMES[chosen.tier]}`, chosen.asOf && `截至${chosen.asOf}`, agree(chosen) > 1 && `${agree(chosen)}个来源一致`].filter(Boolean).join('；') },
      others: ranked.slice(1).map(r => ({ value: r.value, as_of: r.asOf, scope: r.scope, source: r.source, why: why(r) }))
    };
  });
}

const fmt = (n) => String(Math.round(n * 1000) / 1000);
const EXPLAIN = /口径|截至|统计|另有|另据|此前|早先|原先|更正|不同|含|不含|旧|过去|此前|原来|年末|年底|月末|不是|并非/;
/** 交付核对：用了定案就只能用主数字；其他数字出现时，同一句里要写明口径/时间等差别 */
export function reconcileAnswerIssues(text, decisions = []) {
  const answer = String(text || '');
  const sentences = answer.split(/(?<=[。！？!?\n；;])/);
  const has = (n) => new RegExp(`(?<![\\d.])${fmt(n).replace('.', '\\.')}(?![\\d])`);
  const issues = [];
  for (const d of decisions.filter(x => x.conflict)) {
    if (!answer.includes(d.subject) && !answer.includes(d.metric)) continue;
    if (!has(d.chosen.value).test(answer)) { issues.push(`数字定案选的是「${d.subject}${d.metric}」${fmt(d.chosen.value)}${d.unit}（${d.chosen.reason}），回答里没有用这个主数字；按定案改，其他数字写明口径或时间差别`); continue; }
    const loose = d.others.filter(o => !close(o.value, d.chosen.value)).find(o => sentences.some(s => has(o.value).test(s) && !EXPLAIN.test(s)));
    if (loose) issues.push(`「${d.subject}${d.metric}」回答里同时出现了 ${fmt(d.chosen.value)} 和 ${fmt(loose.value)}${d.unit}，后者没说明差别（${loose.why}）；只保留定案的主数字，另一个要写清是哪种口径或哪个时间的数`);
  }
  return issues.slice(0, 3);
}

/**
 * 没调用定案工具时的兜底：同一个回答里，同一主体（表格行首或“南京……为/约/共”）同一单位给了两个不同的数，而且两处都没写口径或时间差别。
 * 只看明确的“主体 + 数字 + 单位”，宁可漏报也不误报。
 */
const UNITS = '公里|千米|平方公里|公顷|条|座|个|万人|亿元|万元|亿人次|万人次|吨|家|所';
export function conflictingNumbers(text) {
  const answer = String(text || '');
  const found = new Map();
  const add = (subject, value, unit, line) => {
    const key = `${subject}|${unit}`;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push({ value: Number(value), line });
  };
  for (const line of answer.split('\n')) {
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').map(c => c.replace(/\*\*/g, '').trim()).filter(Boolean);
      const subject = cells.find(c => /^[一-鿿]{2,8}$/.test(c));
      for (const c of cells) { const m = c.match(new RegExp(`^约?\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})$`)); if (subject && m) add(subject, m[1], m[2], line); }
      continue;
    }
    for (const m of line.replace(/\*\*/g, '').matchAll(new RegExp(`([\\u4e00-\\u9fff]{2,6}?)(?:目前|现在|应为|为|是|约|共有|共|达到|达|有|运营里程|里程|总里程)+\\s*约?\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`, 'g'))) add(m[1], m[2], m[3], line);
  }
  const issues = [];
  for (const [key, rows] of found) {
    const values = [...new Set(rows.map(r => r.value))];
    if (values.length < 2 || rows.every(r => EXPLAIN.test(r.line))) continue;
    const [subject, unit] = key.split('|');
    issues.push(`同一回答里「${subject}」的数字前后不一致（${values.slice(0, 3).map(fmt).join(' / ')}${unit}）；先用 reconcile_numbers 按口径、来源等级、时间定一个主数字，其他数字写明口径或时间差别`);
  }
  return issues.slice(0, 2);
}

export function createNumberReconcileTool() {
  return {
    name: 'reconcile_numbers',
    description: '数字定案：几个来源对同一指标（里程、人口、金额、排名用的数值等）给了不同的数时，先调用本工具定一个主数字再写回答。claims 每条写主体、指标、数值、单位、截至日期、口径（如“地铁”“城市轨道交通含市域线”）、来源名和网址。按 口径对上问题 > 来源等级（官方统计/公告 > 权威媒体 > 门户 > 百科/自媒体）> 截至日期最新 > 多源一致 排序，返回主数字和其他数字差在哪。回答里只用主数字，其他数字要写明是口径或时间不同；不要在正文和表格里用两个不同的数。',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户原问题（用来判断要的是哪种口径）' },
        claims: {
          type: 'array', maxItems: 40,
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' }, metric: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' },
              as_of: { type: 'string', description: '截至日期，如 2026年9月、2025年末' }, scope: { type: 'string', description: '统计口径' },
              source: { type: 'string' }, url: { type: 'string' }
            },
            required: ['subject', 'metric', 'value']
          }
        }
      },
      required: ['claims'],
      additionalProperties: false
    },
    run: async ({ question = '', claims = [] } = {}) => {
      const decisions = reconcileNumbers(claims, { question });
      if (!decisions.length) throw Object.assign(new Error('claims 里没有可比较的数字：每条要有主体、指标和数值'), { name: 'ValidationError', code: 'INVALID_RECONCILE_INPUT' });
      return JSON.stringify({ kind: 'number_reconcile', decisions, note: '回答只用 chosen 的数值并写明口径、截至时间和来源；others 的数如要提，写清 why 里的差别。' });
    }
  };
}
