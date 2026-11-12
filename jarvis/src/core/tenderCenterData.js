import { businessDate, businessDay, cleanBusinessText, noticeMatches, NOTICE_LABELS } from '../agent/businessSources.js';

export const TENDER_LIMITS = Object.freeze({ records: 5000, days: 90, subscriptions: 20, favorites: 100, alerts: 200, interval: 30 * 60_000 });
const fail = message => Object.assign(new Error(message), { status: 400, code: 'TENDER_INPUT' });
/** 金额只认明确人民币单值；多包件、范围、外币和未知值不猜成预算。 */
export function tenderBudget(value) {
  const text = String(value || '').replace(/[,，\s]/g, '');
  if (!text || /美元|欧元|港币|日元|至|~|～|—|;|；/.test(text)) return null;
  const hits = [...text.matchAll(/(?:人民币|￥|¥)?(\d+(?:\.\d+)?)(亿元|万元|元)(?:人民币)?/g)];
  if (hits.length !== 1) return null;
  const number = Number(hits[0][1]) * ({ 元: 1, 万元: 10000, 亿元: 1e8 }[hits[0][2]]);
  return Number.isFinite(number) ? number : null;
}

export function tenderFilters(input = {}) {
  const out = { query: cleanBusinessText(input.query, 120), region: cleanBusinessText(input.region, 30), notice_type: input.notice_type || 'all' };
  if (out.notice_type !== 'all' && !Object.hasOwn(NOTICE_LABELS, out.notice_type)) throw fail('请选择有效公告类型');
  for (const field of ['from', 'to']) {
    out[field] = input[field] ? businessDate(input[field]) : '';
    if (input[field] && !out[field]) throw fail('日期格式不正确');
  }
  if (out.from && out.to && out.from > out.to) throw fail('开始日期不能晚于结束日期');
  for (const field of ['minBudget', 'maxBudget']) {
    out[field] = input[field] === '' || input[field] == null ? null : Number(input[field]);
    if (out[field] !== null && (!Number.isFinite(out[field]) || out[field] < 0 || out[field] > 1e13)) throw fail('预算请输入有效的人民币金额');
  }
  if (out.minBudget !== null && out.maxBudget !== null && out.minBudget > out.maxBudget) throw fail('最低预算不能大于最高预算');
  return out;
}

export function tenderMatches(row, filter) {
  return noticeMatches({ ...row, snippet: `${row.snippet || ''} ${row.projectNumber || ''}` }, filter) && (!filter.from || row.publishedAt >= filter.from) && (!filter.to || row.publishedAt <= filter.to)
    && (filter.minBudget == null || row.budget !== null && row.budget >= filter.minBudget)
    && (filter.maxBudget == null || row.budget !== null && row.budget <= filter.maxBudget);
}

export function retainedTender(row, now) {
  return row.publishedAt >= businessDay(now - TENDER_LIMITS.days * 86400_000) && row.publishedAt <= businessDay(now);
}
