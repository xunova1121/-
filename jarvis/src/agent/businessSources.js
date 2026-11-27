/** 企业与公告的来源、日期及筛选规则；公开检索覆盖有限，不等于全量数据库。 */
export const BUSINESS_SOURCES = Object.freeze([
  { host: 'ccgp.gov.cn', label: '中国政府采购网', kind: 'tender' },
  { host: 'ggzy.gov.cn', label: '全国公共资源交易平台', kind: 'tender' },
  { host: 'b2b.10086.cn', label: '中国移动采购与招标网', kind: 'tender' },
  { host: 'gsxt.gov.cn', label: '国家企业信用信息公示系统', kind: 'company' },
  { host: 'creditchina.gov.cn', label: '信用中国', kind: 'company' },
  { host: 'cninfo.com.cn', label: '巨潮资讯网', kind: 'company' },
  { host: 'sse.com.cn', label: '上海证券交易所', kind: 'company' },
  { host: 'szse.cn', label: '深圳证券交易所', kind: 'company' }
]);
export const businessError = (message, code = 'BUSINESS_INPUT', kind = 'input') => Object.assign(new Error(message), { code, kind });
export const cleanBusinessText = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** 某些公开搜索摘要夹带页面的JSON布局数据，只保留正文部分。 */
export function businessSnippet(value) {
  return cleanBusinessText(String(value || '').split(/"\s*}\s*]\s*,\s*"(?:clamp|isSingleLine|isPc|summarySpan)"/)[0], 400);
}
/** 仅在付款账号、贷款诉讼或第三方项目中提及企业，不构成该企业的工商/股权资料。 */
export function companyMatches(row, subject, section) {
  const title = row.title || '', snippet = row.snippet || '';
  const labels = { basic: /统一社会信用代码|成立日期|注册资本|公司简介|企业简介|基本信息|年度报告|年报/, shareholders: /股东|持股|股权|年度报告|年报/, executives: /董事|高管|监事|年度报告|年报/, investments: /对外投资|子公司|投资企业|年度报告|年报/, news: /公告|报告|动态|消息|发布/ };
  const relevant = labels[section];
  if (!relevant || !relevant.test(title + ' ' + snippet)) return false;
  if (title.includes(subject)) return true;
  // 无企业标题的政府/交易所页面，只收录以该企业为明确主语的资料。
  return ['basic', 'shareholders', 'executives', 'investments'].includes(section)
    && snippet.startsWith(subject) && relevant.test(snippet.slice(subject.length, subject.length + 100));
}
export function businessSource(address) {
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const known = BUSINESS_SOURCES.find(row => host === row.host || host.endsWith('.' + row.host));
    return known ? { ...known, url: url.href } : /(?:^|\.)gov\.cn$/.test(host) ? { host, label: host, kind: 'government', url: url.href } : null;
  } catch { return null; }
}
export function businessDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
/** 只认完整年月日，不能把抓取时间、截止日期或URL路径猜成发布日期。 */
export function businessDate(value) {
  const match = String(value || '').match(/\b(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日)?/);
  if (!match) return '';
  const [, y, m, d] = match;
  const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const n = Date.parse(date + 'T00:00:00+08:00');
  return Number.isFinite(n) && businessDay(n) === date ? date : '';
}
export function businessWindow({ period = 'week', from = '', to = '' } = {}, now = Date.now()) {
  const today = businessDay(now);
  const days = { today: 1, week: 7, month: 30, all: null };
  if (!Object.hasOwn(days, period)) throw businessError('时间范围请选择today、week、month或all');
  const start = from ? businessDate(from) : days[period] ? businessDay(Date.parse(today + 'T00:00:00+08:00') - (days[period] - 1) * 86400_000) : '';
  const end = to ? businessDate(to) : today;
  if (from && !start || to && !end || start && start > end || end > today) throw businessError('请提供有效的起止日期，不能把未来日期当作已发布公告');
  return { from: start, to: end, timezone: 'Asia/Shanghai' };
}
export function noticeType(title) {
  const text = String(title || '');
  if (/更正|变更|澄清|延期|补充公告/.test(text)) return 'correction';
  if (/终止|废标|流标|取消/.test(text)) return 'terminated';
  if (/中标|成交|结果公告|候选人/.test(text)) return 'award';
  if (/意向|计划公告|需求调查|需求公示/.test(text)) return 'intention';
  if (/招标|竞争性|询价|磋商|谈判|比选|采购公告/.test(text)) return 'tender';
  return 'unknown';
}
export const NOTICE_LABELS = { tender: '招标采购', award: '中标成交', correction: '更正延期', terminated: '终止废标', intention: '采购意向', unknown: '类型待核实' };
export function noticeKey(value) {
  try { const url = new URL(value); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(utm_|spm$|from$)/i.test(key)) url.searchParams.delete(key); return url.href; }
  catch { return ''; }
}
/** 只去相同公告URL；同项目的包件、更正、中标必须保留。 */
export function uniqueNotices(rows) {
  const seen = new Set();
  return rows.filter(row => { const key = noticeKey(row.url); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}
export function noticeMatches(row, { query = '', region = '', notice_type = 'all' } = {}) {
  const hay = `${row.title || ''} ${row.snippet || ''} ${row.region || ''}`;
  const location = String(row.snippet || '').match(/(?:项目所在地|项目地点|工程地点|项目地址|服务地点)\s*[:：]\s*([^。；;\n]{1,80})/)?.[1] || '';
  // 供应商/代理机构在江苏，不代表采购项目在江苏；不能用摘要任意提及的省市匹配。
  const regionText = `${row.title || ''} ${row.region || ''} ${location}`;
  const terms = cleanBusinessText(query).split(/[\s,，、]+/).filter(Boolean);
  return terms.every(term => hay.toLowerCase().includes(term.toLowerCase()))
    && (!region || region === '全国' || regionText.includes(region.replace(/[省市]$/, '')))
    && (notice_type === 'all' || row.type === notice_type);
}
