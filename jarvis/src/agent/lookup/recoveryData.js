import { marketFallback } from './fallback.js';
/** 失败分类只使用结构化状态；原始报错只留在工具日志。 */
export function failureKind(error = {}) {
  if (error.name === 'ValidationError' || ['WEATHER_LOCATION_REQUIRED', 'INVALID_STOCK_INPUT'].includes(error.code)) return 'input';
  if ([401, 403, 429].includes(Number(error.status)) || /AUTH|QUOTA|RATE_LIMIT/.test(error.code || '')) return 'auth';
  if (error.code === 'LOOKUP_SOURCE_COOLING') return 'cooling';
  if (['TimeoutError', 'TypeError'].includes(error.name) || ['timeout', 'network'].includes(error.kind) || Number(error.status) >= 500 || /TIMEOUT|ECONN|ENOTFOUND|EAI_AGAIN|NETWORK/.test(error.code || '') || error instanceof TypeError) return 'transient';
  return 'unavailable';
}
export const QUERY_LABELS = { weather: '天气服务', market: '行情服务', sports_live: '赛程服务', news: '新闻来源', sports_news: '体育新闻来源', general: '搜索服务' };
export function failureSentence(kind, attempts) {
  const routes = [...new Set(attempts.map(a => a.label))].slice(0, 4).join('、') || QUERY_LABELS[kind] || '查询来源';
  const reasons = [...new Set(attempts.map(a => a.failure === 'auth' ? '授权或额度不足' : a.failure === 'transient' ? '连接超时或不稳定' : a.failure === 'cooling' ? '暂时不可用' : '未取得有效内容'))].join('、');
  return `${routes}都没取得可用结果（${reasons || '暂时无法连接'}），可以稍后再试。`;
}
export function usefulReceipt(found) {
  if (!found?.output?.trim()) return false;
  try {
    const value = JSON.parse(found.output);
    if (value.kind === 'today_news') return value.items?.length > 0;
    if (Array.isArray(value)) return value.some(row => row.url && (row.snippet || row.title));
    if (found.tool === 'get_stock_kline') return Boolean(value.sourceUrl) && (value.bars?.length > 0 || Number.isFinite(value.latestClose) && Boolean(value.priceDate));
  } catch { /* 原天气与赛程为文字回执。 */ }
  return !/^\s*(?:错误：|\[\]|null)/.test(found.output);
}
export function receiptLinks(output) {
  try { const rows = JSON.parse(output); if (Array.isArray(rows)) return rows.map(r => r.url).filter(Boolean).slice(0, 2); } catch { /* 文本回执 */ }
  return [...String(output).matchAll(/https?:\/\/[^\s<>"）)]+/g)].map(m => m[0]).slice(0, 2);
}
export function recoveryText(found) {
  if (found.recovery?.state === 'failed' || found.recovery?.state === 'input') return found.output;
  let text = found.output;
  try {
    const value = JSON.parse(text);
    if (value.symbol && value.sourceUrl) text = marketFallback(text) || '缓存中的行情字段不完整，暂不能据此给出价格。';
    const items = value.kind === 'today_news' ? value.items : Array.isArray(value) ? value : null;
    if (items) text = (value.cacheTruncated ? '缓存仅保留部分条目与短摘要。\n' : '') + items.slice(0, 12).map(row => `${row.title}\n${row.summary || row.snippet || ''}\n${row.publishedAt || ''} ${row.source || ''} ${row.url || ''}`).join('\n\n');
  } catch { /* 保留真实文本与来源。 */ }
  return [found.recovery?.note, text].filter(Boolean).join('\n\n');
}
