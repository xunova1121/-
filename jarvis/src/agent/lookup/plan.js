import { sportsPreCall } from '../sportsScores.js';
import { supportsSportsNews } from '../newsIntent.js';
import { wantsPreSearch, preSearchQuery } from './prefetch.js';
import { WEATHER_FETCH_MS } from './weatherLimits.js';
import { quoteTarget } from '../marketQuote.js';
import { weatherQueryPlace, validWeatherPlace } from '../weatherPlace.js';

/** “大盘/沪指/深成指/创业板”对应的指数代码；问金价、汇率、港美股、楼盘等不算。 */
export function marketIndex(text) {
  const value = String(text);
  if (/金价|黄金|汇率|油价|币价|港股|恒生|美股|纳斯达克|道琼斯|标普|楼盘|小区|房价|学区/.test(value)) return '';
  if (/创业板/.test(value)) return 'sz399006';
  if (/深成|深证成指|深证指数/.test(value)) return 'sz399001';
  return /大盘|沪指|上证|A股|股市|两市|大A/i.test(value) ? 'sh000001' : '';
}

/** 只提取用户确实说过的地点。无定位、无城市时交模型追问，绝不默认北京/南京。 */
export function weatherPlace(text, params = {}) {
  return weatherQueryPlace(text) || (params.city && validWeatherPlace(params.city) ? params.city : null);
}

/** 一条意图只生成一份预取计划；证券名称/汇率不猜代码，交原搜索工具查证。 */
export function lookupPlan(intent, { text, getTool, now = Date.now() }) {
  if (!intent.lookup || intent.kind === 'meta') return null;
  const params = intent.params || {};
  if (['news', 'sports_news'].includes(intent.kind)) {
    const tool = getTool('get_today_news');
    // 点名了具体对象（日本、马斯克、某事件、汽车……）：汇总源按日期取全量，找不到这个对象，直接搜索
    if (params.subject && getTool('web_search')) return { name: 'web_search', args: { query: preSearchQuery(text) }, timeoutMs: 6000 };
    if (tool && params.dateMode !== 'specified' && (intent.kind !== 'sports_news' || supportsSportsNews(tool))) {
      const categories = params.categories || [];
      const limit = params.perCategory ? Math.min(24, params.perCategory * (categories.length || 5)) : /原文核实|逐条.*(?:原文|核实)|逐项核验/.test(text) && !/[0-9一二三四五六七八九十]+\s*条/.test(text) ? 8 : 12;
      return { name: tool.name, args: { limit, ...(categories.length && { categories }), ...(tool.input_schema?.properties?.date_mode && { date_mode: params.dateMode === 'recent24h' ? 'recent24h' : 'today' }) }, timeoutMs: 9000 };
    }
  } else if (intent.kind === 'weather') {
    const place = weatherPlace(text, params);
    // 与天气操作同一额度，不能外层先取消地点解析和免费备用源。
    return place && getTool('get_weather') ? { name: 'get_weather', args: { place, ...(/空气质量|预警|逐小时|生活指数|紫外线|两小时降水/.test(text) ? { details: true } : {}) }, timeoutMs: WEATHER_FETCH_MS } : null;
  } else if (intent.kind === 'sports_live' && getTool('get_sports_scores')) {
    const args = sportsPreCall(text, now);
    if (args || params.period === 'forward_live') return { name: 'get_sports_scores', args: { ...args, ...(params.period === 'forward_live' && { period: params.period, window_minutes: params.window_minutes, sport: params.sport }) }, timeoutMs: 12000 };
  } else if (intent.kind === 'market' && getTool('get_stock_kline')) {
    const code = String(text).match(/(?<![\dA-Za-z])((?:sh|sz|bj)?\d{6})(?!\d)/i)?.[1];
    if (code && !/实时|分时|汇率|金价|油价|币价|港股|美股|分钟|去年|今年|历史|最高|最低|过去|近\d|20\d{2}/.test(text)) return { name: 'get_stock_kline', args: { code, adjustment: 'none', limit: 3 }, timeoutMs: 8000 };
    // 用户 2026-11-03：“今天大盘的情况”没取指数，只拿原话去搜，回来金价“大盘价”、楼盘“核心大盘”。大盘一律先取指数日K
    const index = !code && marketIndex(text);
    if (index) return { name: 'get_stock_kline', args: { code: index, adjustment: 'none', limit: 3 }, timeoutMs: 8000 };
  }
  if (intent.kind === 'market' && !/去年|今年|历史|最高|最低|过去|近\d|20\d{2}|分时|分钟|持仓|盈亏/.test(text)) {
    // 用户 2026-11-03：金价、汇率、按名字问个股、港美股原先只能搜文章再找数字。先取实时报价，取不到再由流程退回搜索
    const quote = getTool('get_market_quote') && quoteTarget(text);
    if (quote) return { name: 'get_market_quote', args: { target: quote.target }, timeoutMs: 10000 };
    // 油价没有免费接口：搜索词限定成调价公告口径，不用原话（原话常搜回自媒体和旧文）
    if (/油价|汽油|柴油/.test(text) && getTool('web_search')) return { name: 'web_search', args: { query: `今日油价 92号 95号汽油 每升 最新调价 ${new Date(now + 8 * 3600_000).getUTCFullYear()}年` }, timeoutMs: 6000 };
  }
  return getTool('web_search') && (intent.sure || wantsPreSearch(text)) ? { name: 'web_search', args: { query: preSearchQuery(text) }, timeoutMs: 6000 } : null;
}
