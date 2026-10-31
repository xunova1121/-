import { lookupIntent } from './intent.js';
import { runLookup } from './runner.js';
import { newsDate } from '../newsSources.js';
import { newsCoverage } from '../newsRss.js';
import { evidence } from '../evidenceStore.js';

/** get_today_news兼容适配层；真实入口须等国内报告复核后切换，不能启用pending来源。 */
export async function runNewsLookup(ctx, args = {}, execution = {}) {
  const now = ctx.now?.() ?? Date.now();
  const classified = lookupIntent(execution.requestText || '今日新闻');
  const categories = args.categories?.length ? args.categories : classified.params.categories || [];
  const kind = categories.length === 1 && categories[0] === '体育' ? 'sports_news' : 'news';
  const dateMode = classified.params.dateMode === 'specified' ? 'specified' : /今天|今日/.test(execution.requestText || '') ? 'today' : args.date_mode || classified.params.dateMode || 'today';
  const result = await runLookup({ kind, params: { categories, publishers: args.publishers || [], limit: args.limit || 12, dateMode } }, {
    ...ctx.lookup, now, get: ctx.fetchViaGateway || ctx.fetchImpl,
    signal: execution.signal, retrieval: execution.retrieval, progress: execution.progress
  });
  if (execution.signal?.aborted) throw execution.signal.reason;
  if (execution.sessionId && result.items.length) await evidence.put(execution.sessionId, {
    sources: result.items.map(item => ({ url: item.url, title: item.title,
      text: (item.verified === 'page' ? '已读取该来源页面。' : '汇总页/RSS条目，未读报道原文。') + '发布时间：' + item.publishedAt + '\n' + item.title + '\n' + (item.summary || '') }))
  });
  return JSON.stringify({ kind: 'today_news', queryKind: kind, date: newsDate(now), timezone: 'Asia/Shanghai',
    range: result.range, region: result.region, items: result.items,
    sources: result.sources.map(({ items, label, reason, source, ...row }) => ({ ...row, id: source, source: label, count: items.length, ...(reason ? { error: reason } : {}) })),
    failures: result.failures, skipped: result.skipped, coverage: newsCoverage(result.items),
    note: '仅按明确发布时间和本次时间范围交付，不把最近24小时称作今日；RSS不等于已读报道原文，路透转载只证明署名及转载时间，仍非Reuters官网独立核实。按事件展示来源与补充，转载按原始机构归组，不编交叉核验。' });
}
