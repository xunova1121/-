import { NEWS_SOURCES, parseNewsSource } from '../newsSources.js';
import { parseCnsRolling, parseSinaSports, parseZhiboNewsIndex, parseZhiboNewsArticle } from './domesticNews.js';
/** 新国内来源在取得用户服务器报告前均为pending，不用开发环境HTTP200充当国内验收。 */
export const DOMESTIC_NEWS_CANDIDATES = [
  ...NEWS_SOURCES.map(s => ({ ...s, id: 'cn_' + s.id, legacyId: s.id, kind: 'news', region: 'cn', priority: 20, hosts: [new URL(s.url).hostname], category: s.category, timeoutMs: 8000, needsKey: false, validation: 'pending_cn', parse: (body, source, options) => s.id === 'cns' ? parseCnsRolling(body, source, options) : { items: parseNewsSource(body, { ...source, id: s.id }, options.now), candidates: [] } })),
  { id: 'cn_cns_sports', label: '中新网体育', kind: 'sports_news', category: '体育', region: 'cn', priority: 10, url: 'https://www.chinanews.com.cn/scroll-news/news1.html', hosts: ['www.chinanews.com.cn'], timeoutMs: 8000, needsKey: false, validation: 'pending_cn', parse: parseCnsRolling },
  { id: 'cn_zhibo_sports', label: '直播吧新闻', kind: 'sports_news', category: '体育', region: 'cn', priority: 20, url: 'https://news.zhibo8.com/zuqiu/', hosts: ['news.zhibo8.com'], timeoutMs: 8000, needsKey: false, validation: 'pending_cn', parse: parseZhiboNewsIndex, parseArticle: parseZhiboNewsArticle },
  { id: 'cn_sina_sports', label: '新浪体育候选', kind: 'sports_news', category: '体育', region: 'cn', priority: 30, url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2512&num=30&page=1', hosts: ['feed.mix.sina.com.cn', 'sports.sina.com.cn'], timeoutMs: 8000, needsKey: false, validation: 'pending_cn', parse: parseSinaSports }
];
