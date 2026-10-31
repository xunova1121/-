import { sportsPreCall } from '../sportsScores.js';
import { supportsSportsNews } from '../newsIntent.js';
import { wantsPreSearch, preSearchQuery } from './prefetch.js';
import { WEATHER_FETCH_MS } from './weatherLimits.js';

/** 只提取用户确实说过的地点。无定位、无城市时交模型追问，绝不默认北京/南京。 */
export function weatherPlace(text, params = {}) {
  if (params.city) return params.city;
  const value = String(text).replace(/[，,。！？?!]+$/, '').trim();
  const place = value.match(/^(?:请|麻烦)?(?:帮我|给我)?(?:查一?下|查询|看看|看一?下)?\s*(.{1,32}?)(?:今天|今日|明天|后天|现在|这周|本周|未来\d+天)?(?:的)?(?:天气|气温|空气质量)/)?.[1]?.trim();
  if (!place || /^(?:今天|今日|明天|后天|现在|这里|这边|当地|附近|我这|我们这|这个|最近|未来|的|集团年)$/.test(place)) return null;
  if (/天气|带伞|下雨|下雪|怎么|什么|请问|这几天|未来|小时|昨天/.test(place)) return null;
  return place;
}

/** 一条意图只生成一份预取计划；证券名称/汇率不猜代码，交原搜索工具查证。 */
export function lookupPlan(intent, { text, getTool, now = Date.now() }) {
  if (!intent.lookup || intent.kind === 'meta') return null;
  const params = intent.params || {};
  if (['news', 'sports_news'].includes(intent.kind)) {
    const tool = getTool('get_today_news');
    if (tool && params.dateMode !== 'specified' && (intent.kind !== 'sports_news' || supportsSportsNews(tool))) {
      const categories = params.categories || [];
      const limit = params.perCategory ? Math.min(24, params.perCategory * (categories.length || 5)) : /原文核实|逐条.*(?:原文|核实)|逐项核验/.test(text) && !/[0-9一二三四五六七八九十]+\s*条/.test(text) ? 8 : 12;
      return { name: tool.name, args: { limit, ...(categories.length && { categories }), ...(tool.input_schema?.properties?.date_mode && { date_mode: params.dateMode === 'recent24h' ? 'recent24h' : 'today' }) }, timeoutMs: 9000 };
    }
  } else if (intent.kind === 'weather') {
    const place = weatherPlace(text, params);
    // 与天气操作同一额度，不能外层先取消地点解析和免费备用源。
    return place && getTool('get_weather') ? { name: 'get_weather', args: { place }, timeoutMs: WEATHER_FETCH_MS } : null;
  } else if (intent.kind === 'sports_live' && getTool('get_sports_scores')) {
    const args = sportsPreCall(text, now);
    if (args || params.period === 'forward_live') return { name: 'get_sports_scores', args: { ...args, ...(params.period === 'forward_live' && { period: params.period, window_minutes: params.window_minutes, sport: params.sport }) }, timeoutMs: 8000 };
  } else if (intent.kind === 'market' && getTool('get_stock_kline')) {
    const code = String(text).match(/(?<![\dA-Za-z])((?:sh|sz|bj)?\d{6})(?!\d)/i)?.[1];
    if (code && !/实时|分时|汇率|金价|油价|币价|港股|美股|分钟|去年|今年|历史|最高|最低|过去|近\d|20\d{2}/.test(text)) return { name: 'get_stock_kline', args: { code, adjustment: 'none', limit: 3 }, timeoutMs: 8000 };
  }
  return getTool('web_search') && (intent.sure || wantsPreSearch(text)) ? { name: 'web_search', args: { query: preSearchQuery(text) }, timeoutMs: 6000 } : null;
}
