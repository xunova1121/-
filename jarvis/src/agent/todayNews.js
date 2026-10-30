import { NEWS_SOURCES, parseNewsSource, newsDate } from './newsSources.js';
import { decodeBody } from './pageReader.js';
import { webBody } from './webBody.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { evidence } from './evidenceStore.js';
import { internationalNewsFeeds, NEWS_PUBLISHERS } from './newsFeeds.js';
import { parseNewsRss, verifiedReutersReprint, newsCoverage } from './newsRss.js';

/** 固定公开来源并发，国内原解析保留；默认5路加最多3次真实转载页核对，总读取不超过8次。 */
export function createTodayNewsTool(ctx = {}) {
  const get = ctx.fetchViaGateway || ctx.fetchImpl || ((u, o) => fetch(u, o));
  return {
    name: 'get_today_news',
    description: '取得北京时间当天的国内、国际、财经、科技或体育新闻。固定国内汇总及BBC/卫报/半岛电视台公开RSS；路透经CNA转载并实际核对来源栏，不冒充Reuters官方RSS。按栏目或媒体选源，返回短摘要、时间、链接、原始机构和转载标记。按事件对照各家补充及分歧，不把转载当独立验证。不等于已读全部报道原文，明确核实时继续fetch_url；来源不可用保留其他结果。',
    input_schema: { type: 'object', properties: { categories: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['国内', '国际', '财经', '科技', '体育'] } }, publishers: { type: 'array', maxItems: 7, items: { type: 'string', enum: NEWS_PUBLISHERS } }, limit: { type: 'integer', minimum: 1, maximum: 24 } }, additionalProperties: false },
    run: async ({ categories = [], publishers = [], limit = 12 } = {}, { signal, retrieval, progress, sessionId } = {}) => {
      const now = ctx.now?.() ?? Date.now();
      const focused = categories.length === 1 && ['国际', '体育'].includes(categories[0]);
      const domestic = focused ? [] : NEWS_SOURCES.filter(s => (!publishers.length || publishers.includes(s.label)) && (!categories.length || s.category === '综合' || categories.includes(s.category)));
      const international = categories.length === 1 && categories[0] === '国内' ? [] : internationalNewsFeeds(categories, publishers);
      const sources = ctx.newsSources || [...domestic, ...international].slice(0, 7);
      const checks = Math.max(0, Math.min(3, 8 - sources.length));
      const read = async (url, activeSignal) => {
        retrieval?.consume('read');
        const response = await get(url, { signal: activeSignal, credentials: 'omit' });
        if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { code: 'NEWS_HTTP', kind: 'api' });
        const bytes = await webBody(response, 800 * 1024, activeSignal);
        return decodeBody(bytes, response.headers.get('content-type') || '');
      };
      const results = await Promise.all(sources.map(async source => {
        try {
          progress?.('正在读取' + source.label + '今日新闻');
          const items = await withWebDeadline(async activeSignal => {
            const body = await read(source.url, activeSignal);
            const rows = source.format === 'rss' ? parseNewsRss(body, source, now) : parseNewsSource(body, source, now);
            if (!source.reprint) return rows;
            // CNA滚动队列也夹有评论/生活稿；先看新闻频道，仍须逐页核对署名，不能靠频道认定路透。
            const candidates = rows.filter(item => /^\/(?:world|asia|business|sport)\//.test(new URL(item.url).pathname));
            const verified = await Promise.all(candidates.slice(0, checks).map(async item => {
              try { return verifiedReutersReprint(await read(item.url, activeSignal), item, now); }
              catch (error) { throwControl(error, activeSignal); return null; }
            }));
            return verified.filter(Boolean);
          }, { signal, timeoutMs: 8000 });
          return { source: source.label, url: source.url, items, ...(items.length ? {} : { error: source.reprint ? '本次未取得已核对路透署名及当日转载时间的稿件；不以CNA自采、图片署名或搜索索引充数' : '未解析到带当天发布时间的条目，可能尚未更新或版式变化' }) };
        } catch (error) {
          throwControl(error, signal);
          return { source: source.label, url: source.url, items: [], error: String(error.message).slice(0, 160) };
        }
      }));
      if (signal?.aborted) throw signal.reason;
      // 轮流取各来源，不能让一个来源占满所有名额。只按同URL去重，不擅自合并有冲突的事实。
      const items = [], seen = new Set();
      const candidates = [];
      for (let i = 0; i < 36; i++) for (const row of results) if (row.items[i]) candidates.push(row.items[i]);
      const groups = categories.length ? categories : ['国内', '国际', '财经', '科技', '体育'];
      // 各栏目轮流取，避免财经或国内来源占满名额；缺栏目不能补猜。
      const buckets = groups.map(category => candidates.filter(item => item.category === category));
      for (let i = 0; i < 36 && items.length < Math.min(24, Math.max(1, limit)); i++) for (const bucket of buckets) {
        const item = bucket[i];
        if (!item || seen.has(item.url)) continue;
        seen.add(item.url); items.push(item);
        if (items.length >= Math.min(24, Math.max(1, limit))) break;
      }
      if (sessionId && items.length) await evidence.put(sessionId, { sources: items.map(item => ({ url: item.url, title: item.title, text: '汇总页条目，未读报道原文。发布时间：' + item.publishedAt + '\n' + item.title + '\n' + item.summary })) });
      return JSON.stringify({ kind: 'today_news', date: newsDate(now), timezone: 'Asia/Shanghai', items,
        sources: results.map(({ items: rows, ...row }) => ({ ...row, count: rows.length })), coverage: newsCoverage(items),
        note: '以中文简报按事件对照各家新增信息及有依据的分歧，保留来源和原链接；转载按原始通讯社去重。RSS/汇总页不等于原文已核实；CNA来源栏核对只证明转载署名及转载页时间，不是Reuters官网原文独立核实。缺失栏目或来源不凑数。' });
    }
  };
}
