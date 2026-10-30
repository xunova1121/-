import { NEWS_SOURCES, parseNewsSource, newsDate } from './newsSources.js';
import { decodeBody } from './pageReader.js';
import { webBody } from './webBody.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { evidence } from './evidenceStore.js';

/** 固定3个国内公开滚动/汇总页并发；不依赖模型猜当天地址，不执行页面脚本，不重试收费服务。 */
export function createTodayNewsTool(ctx = {}) {
  const get = ctx.fetchViaGateway || ctx.fetchImpl || ((u, o) => fetch(u, o));
  return {
    name: 'get_today_news',
    description: '取得北京时间当天新闻。并发读取新华财经、央广和中新网当天滚动/汇总页，返回标题、摘要（若来源提供）、发布时间、真实链接及栏目；部分来源失败不影响已有结果。不等于逐条报道原文已核实，用户明确要核实原文时继续fetch_url。不要重复搜索同一批新闻。',
    input_schema: { type: 'object', properties: { categories: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['国内', '国际', '财经', '科技'] } }, limit: { type: 'integer', minimum: 1, maximum: 24 } }, additionalProperties: false },
    run: async ({ categories = [], limit = 12 } = {}, { signal, retrieval, progress, sessionId } = {}) => {
      const now = ctx.now?.() ?? Date.now();
      const results = await Promise.all(NEWS_SOURCES.map(async source => {
        try {
          retrieval?.consume('read');
          progress?.('正在读取' + source.label + '今日新闻');
          const items = await withWebDeadline(async activeSignal => {
            const response = await get(source.url, { signal: activeSignal, credentials: 'omit' });
            if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { code: 'NEWS_HTTP', kind: 'api' });
            const bytes = await webBody(response, 800 * 1024, activeSignal);
            return parseNewsSource(decodeBody(bytes, response.headers.get('content-type') || ''), source, now);
          }, { signal, timeoutMs: 8000 });
          return { source: source.label, url: source.url, items, ...(items.length ? {} : { error: '未解析到带当天发布时间的条目，可能尚未更新或版式变化' }) };
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
      const groups = categories.length ? categories : ['国内', '国际', '财经', '科技'];
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
        sources: results.map(({ items: rows, ...row }) => ({ ...row, count: rows.length })),
        note: '条目取自实际读取的当天汇总/滚动页；未逐条打开报道原文，待核实。不编补缺失栏目、摘要或时间。' });
    }
  };
}
