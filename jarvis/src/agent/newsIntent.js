import { lookupIntent } from './lookup/intent.js';
/** 兼容旧导出，实际判断集中到lookup意图表，提示说明留第3步统一。 */
export function lookupComplaint(text = '') {
  return lookupIntent(text).params.metaType === 'status';
}
/** 体育新闻与比分是不同目标；不因历史里刚问过赛程就把资讯换成比分。 */
export function sportsNewsTopic(text = '') {
  return lookupIntent(text).kind === 'sports_news';
}
export function sportsNewsIntent(text = '', options) {
  const intent = lookupIntent(text, options);
  return intent.kind === 'sports_news' && !intent.params.includeScores;
}
export const supportsSportsNews = tool => Boolean(tool?.input_schema?.properties?.categories?.items?.enum?.includes('体育'));
export function newsCategoryRequest(text = '', options) {
  const intent = lookupIntent(text, options);
  return ['news', 'sports_news'].includes(intent.kind) ? intent.params.categories : [];
}
export const SPORTS_NEWS_NOTE = '用户要的是体育资讯：使用明确支持体育栏目的新闻工具或web_search查报道，给出新闻内容和来源，不能用赛程表、对阵或比分卡替代。没有体育栏目的综合汇总不能替代体育资讯，必要时fetch_url读报道。历史中的赛程话题不能覆盖本次资讯要求。';
export function todayNewsIntent(text = '', options) {
  const intent = lookupIntent(text, options);
  return intent.kind === 'news' && intent.params.dateMode !== 'specified';
}
export const NEWS_LOOKUP_NOTE = '今日新闻优先使用get_today_news，按北京时间当天筛选。以中文按事件整理，保留各家原文链接，说明各家新增信息和有依据的分歧。跨语言仅在主体、地点、事件和时间对得上时归组；不确定就分别列，不拼接矛盾数字，不把转载当独立报道，不用媒体数量冒充已核实。拿到多少先给多少，不只交链接，不把标题扩写成未取得的事实。区分汇总/RSS、转载署名核对和报道原文已核实，明确核实时仍读对应报道。';
export function newsLookupNote(text) {
  return lookupIntent(text).params.dateMode === 'recent24h'
    ? NEWS_LOOKUP_NOTE.replace('今日新闻', '新闻查询').replace('按北京时间当天筛选', '按北京时间最近24小时筛选，不统称为今日')
    : NEWS_LOOKUP_NOTE;
}
export const WEB_LOOKUP_NOTE = '查几个方面或几个对象时，同一轮一起调用web_search/fetch_url，或使用web_search.queries并发；次数照常计预算。先给已查到的具体内容并附来源，来源矛盾分别说明；只见搜索摘要或汇总页时明确尚未读报道原文，不冒充核实。够用就答，不为凑次数重复搜索。公开JSON数据可用fetch_json，只有设置里信任的域名可读，不猜数据单位、复权口径或日期。';
