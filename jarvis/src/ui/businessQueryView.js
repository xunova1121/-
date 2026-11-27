/** 企业查询回执只展示实际字段和来源；公开检索线索不升级成工商事实。 */
import { isPrivateHost } from '../../shared/providers.js';

export const COMPANY_SECTIONS = { basic: '企业概况', shareholders: '股东股权', executives: '主要人员', investments: '对外投资' };
const FIELDS = new Set(['企业名称', '统一社会信用代码', '法定代表人', '注册资本（万元）', '资本币种', '成立日期', '经营状态', '住所', '经营范围', '登记机关', '股东名称', '认缴出资额（万元）', '出资比例', '出资日期', '高管姓名', '职务']);
const text = (value, limit = 600) => typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/\b(?:sk-|tvly-)[A-Za-z0-9_-]{8,}/g, '[已隐藏]').slice(0, limit) : '';
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];

export function companySourceURL(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.replace(/\.$/, '');
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !host.includes('.') || isPrivateHost(host) || host.endsWith('.internal')) return '';
    if (url.href.length > 2048 || /(?:[?&#](?:key|api_key|access_key|token|access_token)=|sk-[\w-]{8,})/i.test(decodeURIComponent(url.href))) return '';
    return url.href;
  } catch { return ''; }
}

export function normalizeCompanyReceipt(raw) {
  if (typeof raw === 'string') {
    if (raw.length > 120000) throw new Error('企业资料过大，请缩小查询范围后重试。');
    try { raw = JSON.parse(raw); } catch { throw new Error('企业查询返回格式无法识别，请重试。'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('企业查询没有返回可用回执，请重试。');
  const rows = list(raw.rows, 10).filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => Object.entries(row).filter(([key, value]) => FIELDS.has(key) && text(value)).map(([key, value]) => [key, text(value)]))
    .filter(row => row.length);
  const sourceRows = (items, pending) => list(items, pending ? 3 : 6).filter(row => row && typeof row === 'object').map(row => ({
    title: text(row.title, 180), url: companySourceURL(row.url), snippet: text(row.snippet || row.excerpt, 600),
    source: text(row.source, 80), reason: text(row.reason, 160), pending,
    originalRead: row.originalRead === true && row.evidence === 'original_page', evidence: text(row.evidence, 40)
  })).filter(row => row.url || row.title || row.snippet);
  const qibook = raw.source === '企百科' || raw.source === 'qibook';
  return {
    company: text(raw.company, 100), section: Object.hasOwn(COMPANY_SECTIONS, raw.section) ? raw.section : 'basic',
    source: qibook ? '企百科' : '公开资料', state: text(raw.state, 40),
    rows: qibook ? rows : [], items: sourceRows(raw.items, false), leads: sourceRows(raw.leads, true),
    warnings: list(raw.warnings, 5).map(row => ({ source: text(row?.source, 80), code: /^[A-Z][A-Z0-9_]{1,59}$/.test(row?.code || '') ? row.code : '' })),
    dataRetrieved: raw.dataRetrieved === true, truncated: raw.truncated === true,
    retrievedAt: typeof raw.retrievedAt === 'string' && Number.isFinite(Date.parse(raw.retrievedAt)) ? raw.retrievedAt : '',
    note: text(raw.note, 500)
  };
}

export function companyFollowupDraft(receipt, query) {
  const company = receipt.company || query.company;
  const facts = receipt.rows.slice(0, 3).flatMap(row => row.slice(0, 10).map(([key, value]) => `${key}：${value}`)).join('\n').slice(0, 800);
  const sources = [...receipt.items, ...receipt.leads].slice(0, 3).map(row => `${row.title}\n${row.url}\n${row.snippet.slice(0, 180)}`).join('\n');
  const limits = receipt.source === '企百科' ? '企百科数据更新日未知；工商股东、实际控制人和法定代表人须分别核对，不能互相替代。\n' : '';
  return `请继续分析${company}的${COMPANY_SECTIONS[query.section] || '企业资料'}。以下是查询回执中的资料与线索，公开摘要须先读原文核实；缺失内容不要编造。\n来源：${receipt.source}${receipt.retrievedAt ? `；查询时间：${receipt.retrievedAt}` : ''}\n${limits}${facts}\n${sources}`.slice(0, 2000);
}

export function companyResultView(raw, query, { el, onFill }) {
  const result = normalizeCompanyReceipt(raw);
  const available = result.rows.length || result.items.length || result.leads.length;
  const region = el('section', { className: 'wy-business-results', ariaLabel: '企业查询结果' });
  const title = el('div', { className: 'wy-business-result-head' },
    el('div', {}, el('h3', { textContent: result.company || query.company }),
      el('p', { textContent: `${COMPANY_SECTIONS[query.section]} · ${result.source}` })),
    el('span', { className: 'wy-business-badge', textContent: result.rows.length ? '接口资料' : available ? '待核实线索' : '暂未取得资料' }));
  region.append(title);
  if (result.retrievedAt) region.append(el('p', { className: 'wy-business-time', textContent: '查询时间：' + new Date(result.retrievedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' }));
  for (const row of result.rows) {
    const details = el('dl', { className: 'wy-business-data-grid' });
    for (const [key, value] of row) details.append(el('div', {}, el('dt', { textContent: key }), el('dd', { textContent: value })));
    region.append(el('article', { className: 'wy-business-data-card' }, details));
  }
  if (result.rows.length) region.append(el('p', { className: 'wy-business-note', textContent: '企百科接口返回资料，尚未提供数据更新日。工商股东、实际控制人和法定代表人需要分别核对。' }));
  for (const row of [...result.items, ...result.leads]) {
    const card = el('article', { className: 'wy-business-source-card' },
      el('span', { className: 'wy-business-source-state', textContent: row.pending ? '待核实' : row.originalRead ? '已读取原文' : '公开检索线索 · 未核实原文' }),
      el('h4', { textContent: row.title || '资料来源' }));
    if (row.snippet) card.append(el('p', { textContent: row.snippet }));
    if (row.reason) card.append(el('p', { className: 'wy-business-note', textContent: row.reason }));
    if (row.url) card.append(el('a', { href: row.url, target: '_blank', rel: 'noopener noreferrer', textContent: '查看来源 · ' + (row.source || new URL(row.url).hostname) }));
    region.append(card);
  }
  if (!available) region.append(el('p', { className: 'wy-business-empty', textContent: result.state === 'failed'
    ? '本次来源没有成功返回资料。可保留企业名称重试，或更换已配置的资料来源。'
    : '本次没有取得可用企业资料。可补充企业全称或统一社会信用代码后再查；这不代表企业不存在。' }));
  if (result.warnings.length || result.truncated) {
    const details = el('details', { className: 'wy-business-result-warnings' }, el('summary', { textContent: '来源状态与待核实事项' }));
    for (const warning of result.warnings) details.append(el('p', { textContent: `${warning.source || '部分来源'}：未取得可用资料${warning.code ? `（${warning.code}）` : ''}` }));
    if (result.truncated) details.append(el('p', { textContent: '此处仅显示部分返回资料，需缩小查询范围核对更多记录。' }));
    region.append(details);
  }
  if (result.items.length || result.leads.length) region.append(el('p', { className: 'wy-business-note', textContent: '公开检索结果用于寻找资料，不能直接当作已核实的工商、股权或实时信息。' }));
  if (available) {
    const follow = el('button', { type: 'button', className: 'wy-business-continue', textContent: '继续分析' });
    follow.addEventListener('click', () => onFill(companyFollowupDraft(result, query)));
    region.append(follow, el('small', { className: 'wy-business-note', textContent: '先填入对话草稿，由你确认发送。' }));
  }
  return region;
}
