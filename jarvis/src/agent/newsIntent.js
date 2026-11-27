import { lookupIntent } from './lookup/intent.js';
/** 兼容旧导出，实际判断集中到lookup意图表，说明集中在lookup/answer。 */
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
export function todayNewsIntent(text = '', options) {
  const intent = lookupIntent(text, options);
  return intent.kind === 'news' && intent.params.dateMode !== 'specified';
}

export { SPORTS_NEWS_NOTE, NEWS_LOOKUP_NOTE, WEB_LOOKUP_NOTE, newsLookupNote } from './lookup/answer.js';
