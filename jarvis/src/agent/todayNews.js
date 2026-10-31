import { legacyNewsLookup } from './lookup/legacyNews.js';
import { NEWS_PUBLISHERS } from './newsFeeds.js';
import { runNewsLookup } from './lookup/news.js';

/** 固定公开来源并发，国内原解析保留；默认5路加最多3次真实转载页核对，总读取不超过8次。 */
export function createTodayNewsTool(ctx = {}) {
  return {
    name: 'get_today_news',
    description: (ctx.lookup && !ctx.newsSources ? '取得北京时间今日或最近24小时的国内、国际、财经、科技或体育新闻，国内已实测来源优先。' : '取得北京时间当天的国内、国际、财经、科技或体育新闻。') + '固定国内汇总及BBC/卫报/半岛电视台公开RSS；路透经CNA转载并实际核对来源栏，不冒充Reuters官方RSS。按栏目或媒体选源，返回短摘要、时间、链接、原始机构和转载标记。按事件对照各家补充及分歧，不把转载当独立验证。不等于已读全部报道原文，明确核实时继续fetch_url；来源不可用保留其他结果。',
    input_schema: { type: 'object', properties: { categories: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['国内', '国际', '财经', '科技', '体育'] } }, publishers: { type: 'array', maxItems: 7, items: { type: 'string', enum: NEWS_PUBLISHERS } }, limit: { type: 'integer', minimum: 1, maximum: 24 }, ...(ctx.lookup && !ctx.newsSources ? { date_mode: { type: 'string', enum: ['today', 'recent24h'], description: '今日或最近24小时；不要把昨日稿写成今日' } } : {}) }, additionalProperties: false },
    run: async ({ categories = [], publishers = [], limit = 12, date_mode } = {}, execution = {}) => {
      if (ctx.lookup && !ctx.newsSources) return runNewsLookup(ctx, { categories, publishers, limit, date_mode }, execution);
      return legacyNewsLookup(ctx, { categories, publishers, limit }, execution);
    }
  };
}
