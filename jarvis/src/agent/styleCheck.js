/**
 * 改动核对：用户说“字体大点 / 铺满一页 / 标题下面不要横线 / 不要下划线”，改完要把真实文件读回来对一遍，
 * 回答只能说文件里真的发生了的事（用户 2026-10-29 反馈：招租广告连改 5 次，字号一直没变，回答却说“已加大”）。
 *
 *   - styleRequests：从用户原话里认出这类调整要求（只认用户的话，不认模型自己的计划）
 *   - measureDocx：量 Word 里实际的正文字号、最大字号（标题）、横线（段落上下边框）条数、下划线处数
 *   - rememberStyle：按对话记住上一版的量值，“再大点”才有比较的基准
 *   - styleIssues：回答说做到了、文件里却没做到（或没法核对）时，给出要改写的问题
 */
import { openOfficePackage } from './officePackage.js';
import { collection } from './store.js';

const SEP = '[^，,。；;！!？?\\n]';
const REQUESTS = [
  ['bigger', '字体加大', new RegExp(`(?:字|字体|字号|内文|内筒|正文|内容|标题)${SEP}{0,6}(?:大一?点|大些|放大|加大|调大|再大)|(?:放大|加大|调大)${SEP}{0,4}(?:字|字体|字号)|(?:字|字体|字号)${SEP}{0,4}(?:还是|太|有点|偏)小|大字`)],
  ['smaller', '字体缩小', new RegExp(`(?:字|字体|字号)${SEP}{0,6}(?:小一?点|小些|缩小|调小|再小)|(?:字|字体|字号)${SEP}{0,4}(?:太|有点|偏)大`)],
  ['fill', '铺满一页', /铺满|铺板|满版|占满|撑满|一整页|整页面|整个页面/],
  ['noRule', '不要横线', new RegExp(`(?:不要|去掉|别|删掉|删除|取消|不加|不用)${SEP}{0,8}(?:横线|分割线|分隔线|线条)`)],
  ['noUnderline', '不要下划线', new RegExp(`(?:不要|去掉|别|删掉|删除|取消|不加|不用)${SEP}{0,6}下划线`)]
];
/** 用户这次要的调整（同一轮补充的话也算） */
export function styleRequests(text = '') {
  const value = String(text).slice(-4000).replace(/[“「"][^”」"\n]*[”」"]/g, '');
  const found = REQUESTS.filter(([, , re]) => re.test(value)).map(([id, label]) => ({ id, label }));
  // “字大点”和“字小点”同时出现时（多半是在说标题大、正文小之类），不判断方向
  return found.some((r) => r.id === 'bigger') && found.some((r) => r.id === 'smaller') ? found.filter((r) => !['bigger', 'smaller'].includes(r.id)) : found;
}
/** 只说标题时比标题，其余比正文（“字体大点”一般说的是满篇的字） */
const titleOnly = (text) => /标题/.test(text) && !/内文|内筒|正文|内容|全部|所有|整体|字体大|字大/.test(text);

const prop = (xml, tag) => xml.match(new RegExp(`<w:${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</w:${tag}>)`))?.[0] || '';
const val = (xml) => xml.match(/w:val="([^"]+)"/)?.[1];
const hasRule = (pPr) => /<w:pBdr\b[\s\S]*?<w:(?:top|bottom)\b(?![^>]*w:val="(?:none|nil)")/.test(prop(pPr, 'pBdr'));
const hasUnderline = (rPr) => { const u = prop(rPr, 'u'); return Boolean(u) && !/w:val="(?:none|0)"/.test(u); };

/** 量 Word 里实际的字号和线条（磅）。读不了返回 null，不当成“做到了” */
export async function measureDocx(blob) {
  try {
    const zip = await openOfficePackage(blob);
    const styles = (await zip.file('word/styles.xml')?.async('string')) || '';
    const doc = (await zip.file('word/document.xml')?.async('string')) || '';
    if (!doc || doc.length > 4e6 || styles.length > 2e6) return null;
    const base = Number(val(prop(prop(styles, 'rPrDefault'), 'sz'))) || 20;
    const defs = new Map();
    let defaultPara = '';
    for (const [xml] of styles.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)) {
      const id = xml.match(/w:styleId="([^"]+)"/)?.[1];
      if (!id) continue;
      if (/w:type="paragraph"/.test(xml) && /w:default="(?:1|true)"/.test(xml)) defaultPara = id;
      defs.set(id, { basedOn: val(prop(xml, 'basedOn')), sz: Number(val(prop(prop(xml, 'rPr'), 'sz'))) || 0, rule: hasRule(prop(xml, 'pPr')), u: hasUnderline(prop(xml, 'rPr')) });
    }
    const chain = (id, key) => {
      for (let i = 0, s = defs.get(id); s && i < 8; i++, s = defs.get(s.basedOn)) if (s[key]) return s[key];
      return key === 'sz' ? base : false;
    };
    const sizes = new Map();
    let rules = 0, underlines = 0, max = 0;
    for (const [p] of doc.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
      const pPr = prop(p, 'pPr');
      const style = val(prop(pPr, 'pStyle')) || defaultPara;
      if (hasRule(pPr) || chain(style, 'rule')) rules++;
      for (const [r] of p.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
        const text = [...r.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').replace(/\s/g, '');
        if (!text) continue;
        const rPr = prop(r, 'rPr');
        const size = (Number(val(prop(rPr, 'sz'))) || chain(style, 'sz')) / 2;
        if (hasUnderline(rPr) || chain(val(prop(rPr, 'rStyle')), 'u') || chain(style, 'u')) underlines++;
        sizes.set(size, (sizes.get(size) || 0) + text.length);
        max = Math.max(max, size);
      }
    }
    if (!sizes.size) return null;
    // 正文 = 字数最多的那个字号（标题字少，不影响）
    const body = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    return { format: 'docx', body, title: max, rules, underlines };
  } catch {
    return null;
  }
}

const kv = collection('kv');
const KEY = 'style-facts';
/**
 * 记下这一版的量值，返回上一轮最后一版（同一轮里多次生成，基准仍是上一轮的）。
 * @param {{ sessionId?: string, scope?: string, facts: object|null }} p
 */
export async function rememberStyle({ sessionId, scope, facts }) {
  if (!sessionId || !facts) return null;
  try {
    const all = (await kv.get(KEY))?.sessions ?? {};
    const old = all[sessionId] || {};
    const previous = old.scope === scope ? old.previous ?? null : old.current ?? null;
    all[sessionId] = { scope, current: facts, previous, at: Date.now() };
    // 只留最近 50 段对话
    const kept = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 50));
    await kv.put({ id: KEY, sessions: kept });
    return previous;
  } catch {
    return null;
  }
}

/** 上一轮最后一版的量值（生成前用来算“再大点”的基准；只读不写） */
export async function lastStyle(sessionId, scope) {
  if (!sessionId) return null;
  try {
    const entry = (await kv.get(KEY))?.sessions?.[sessionId];
    return !entry ? null : entry.scope === scope ? entry.previous ?? null : entry.current ?? null;
  } catch {
    return null;
  }
}

const DEFAULT = { body: 12, title: 22 }; // 一般文档默认字号（docxWriter.js）
const step = (n, up) => Math.max(8, Math.min(72, Math.round(up ? Math.max(n * 1.25, n + 2) : Math.min(n * 0.85, n - 1))));
/**
 * 把“字大点 / 小点”换算成字号：在上一版实际字号上放大 / 缩小一档（约 25% / 15%）。
 * 用户说了具体字号的那个角色不动；单页告示本来就按页面取最大字号，“大点”不再放大（放大就排不进一页），“小点”缩一档。
 * @returns {{ typography: object, scale: number }}
 */
export function relativeTypography(typography = {}, asks = [], { kind = '', previous = null, request = '' } = {}) {
  const dir = asks.some((a) => a.id === 'bigger') ? 1 : asks.some((a) => a.id === 'smaller') ? -1 : 0;
  if (!dir) return { typography, scale: 0 };
  if (kind === 'poster') return { typography, scale: dir < 0 && !typography.body?.size ? 0.85 : 0 };
  const base = previous || DEFAULT;
  const roles = titleOnly(request) ? ['title'] : /内文|内筒|正文|内容/.test(request) && !/标题/.test(request) ? ['body'] : ['body', 'title'];
  const next = { ...typography };
  for (const role of roles) if (!typography[role]?.size) next[role] = { ...typography[role], size: step(base[role], dir > 0) };
  return { typography: next, scale: 0 };
}

/**
 * 逐项判断：done 做到了 / missed 没做到 / unchecked 没法核对
 * @param {string} request 用户原话
 * @param {{ format: string, styleFacts?: object|null, previousStyle?: object|null, pages?: number|null }} artifact 最后一份文件
 */
export function styleReport(request, artifact) {
  const asks = styleRequests(request);
  if (!asks.length || !artifact) return [];
  const f = artifact.styleFacts;
  const prev = artifact.previousStyle;
  const role = titleOnly(request) ? 'title' : 'body';
  const name = role === 'title' ? '标题' : '正文';
  const sizes = f ? `标题${f.title}磅、正文${f.body}磅` : '';
  return asks.map(({ id, label }) => {
    if (!f) return { id, label, state: 'unchecked', detail: `${artifact.format || '这种'}文件读不出字号和线条，没法确认` };
    if (id === 'bigger' || id === 'smaller') {
      if (!prev) return { id, label, state: 'unchecked', detail: `没有上一版的字号可比；这一版实际${sizes}` };
      const grew = f[role] > prev[role], shrank = f[role] < prev[role];
      const ok = id === 'bigger' ? grew : shrank;
      return { id, label, state: ok ? 'done' : 'missed', detail: `${name}从${prev[role]}磅${f[role] === prev[role] ? '没变' : '变成' + f[role] + '磅'}` };
    }
    if (id === 'noRule') return { id, label, state: f.rules ? 'missed' : 'done', detail: f.rules ? `文件里还有${f.rules}条横线（段落上下边框）` : '文件里没有横线' };
    if (id === 'noUnderline') return { id, label, state: f.underlines ? 'missed' : 'done', detail: f.underlines ? `文件里还有${f.underlines}处下划线` : '文件里没有下划线' };
    // 铺满：程序量不出空白占多少，只能确认页数和字号
    if (artifact.pages > 1) return { id, label, state: 'missed', detail: `实际${artifact.pages}页，不是一页` };
    return { id, label, state: 'unchecked', detail: `是否铺满没有自动检查；实际${sizes}${artifact.pages === 1 ? '，1页' : ''}` };
  });
}

const NOT = '(?<!没|没有|未|未能|不能|无法|没能|不|仍)';
const CLAIMS = {
  bigger: new RegExp(`${NOT}(?:调大|放大|加大|更大|大字)`),
  smaller: new RegExp(`${NOT}(?:调小|缩小|更小)`),
  fill: new RegExp(`${NOT}(?:铺满|满版|占满|撑满)`),
  noRule: /(?:没有|无|去掉了?|去除了?|删掉了?|不加|不再有)[^，。；\n]{0,6}(?:横线|分割线|分隔线|线条)/,
  noUnderline: /(?:没有|无|去掉了?|去除了?|删掉了?|不加|不再有)[^，。；\n]{0,4}下划线/
};

/** 回答声称做到、文件却没做到 / 没法核对 → 要求按实际改写 */
export function styleIssues(request, answer, artifact) {
  // 文件名、链接里的“大字版”不算声称
  const text = String(answer).replace(/\[[^\]\n]*\]\([^)\n]*\)|《[^》\n]*》|`[^`\n]*`/g, '');
  const wrong = styleReport(request, artifact).filter((r) => r.state !== 'done' && CLAIMS[r.id].test(text));
  if (!wrong.length) return [];
  return [`回答说做到了，但读回文件对不上：${wrong.map((r) => `“${r.label}”${r.state === 'missed' ? '没做到' : '没法确认'}（${r.detail}）`).join('；')}。按文件里的实际情况重写：做到的照说，没做到的直说没做到和原因（比如这个工具调不了字号时，请用户说具体字号，如“正文小初、标题初号”），不要写“已加大 / 已去掉”`];
}

/** 收尾前给模型看的实际量值（只在用户提了这类要求时） */
export function styleNote(request, artifact) {
  const rows = styleReport(request, artifact);
  if (!rows.length) return '';
  return '用户要的调整，读回文件的实际结果：' + rows.map((r) => `${r.label}：${{ done: '做到了', missed: '没做到', unchecked: '没法确认' }[r.state]}（${r.detail}）`).join('；') + '。回答照这个说';
}
