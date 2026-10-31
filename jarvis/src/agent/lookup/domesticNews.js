import { newsPlain, newsDate } from '../newsSources.js';

const beijingTime = at => new Date(at + 28800000).toISOString().slice(0, 19) + '+08:00';
export function lookupTimeRange(params = {}, now = Date.now()) {
  const mode = params.dateMode || 'today';
  const from = mode === 'recent24h' ? now - 86400000 : Date.parse(newsDate(now) + 'T00:00:00+08:00');
  return { mode, from, until: now };
}
function inRange(at, range) { return Number.isFinite(at) && at >= range.from && at <= range.until; }
const validBeijingStamp = value => Number.isFinite(Date.parse(value)) && beijingTime(Date.parse(value)) === value;
function safeLink(value, source) {
  try {
    const url = new URL(newsPlain(value), source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !source.hosts.includes(url.hostname) || url.href.length > 1200) return null;
    return url.href;
  } catch { return null; }
}
const item = (source, values) => ({ source: source.label, sourceId: source.id, sourceFamily: source.family || source.id, kind: source.kind, category: source.category, verified: 'index', verification: 'index_only', ...values });
/** 栏目不等于主题：时政/财经也会发布算力、芯片等科技消息，只作标题召回，不生成新事实。 */
function technologyHeadline(title, column) {
  if (!column || /体育|文娱|娱乐|文化|图片|视频/.test(column)) return false;
  return /科技|算力|人工智能|大模型|芯片|半导体|量子|机器人|航天|卫星|火箭|核聚变|超导|光子|科研|科学家|太空|脑机接口|集成电路|(?<![a-z0-9])(?:AI|5G|6G)(?![a-z0-9])/i.test(title);
}

/** 中新滚动的真实栏目+明确MM-DD HH:mm；链接只补年份，不把URL日期当发布时间。 */
export function parseCnsRolling(html, source, { now = Date.now(), params = {} } = {}) {
  const range = lookupTimeRange(params, now); const out = [], seen = new Set();
  const techOnly = source.kind === 'news' && params.categories?.length === 1 && params.categories[0] === '科技';
  const clean = String(html).slice(0, 1024 * 1024).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const match of clean.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    if (out.length >= 36) break;
    const row = match[1].slice(0, 16000);
    const column = newsPlain(row.match(/class=["']dd_lm["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    const category = /体育/.test(column) ? '体育' : /国际/.test(column) ? '国际' : /财经/.test(column) ? '财经' : /科技/.test(column) ? '科技' : /国内|时政|社会/.test(column) ? '国内' : '其他';
    if (source.kind === 'sports_news' ? category !== '体育' : category === '体育' || category === '其他' && !techOnly) continue;
    if (!techOnly && params.categories?.length && !params.categories.includes(category)) continue;
    const stamp = row.match(/class=["']dd_time["'][^>]*>\s*(\d{2}-\d{2})\s+(\d{2}:\d{2})/i);
    if (!stamp) continue;
    for (const anchor of row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = safeLink(anchor[1], source); const title = newsPlain(anchor[2]);
      if (!url || title.length < 8 || title.length > 180 || seen.has(url)) continue;
      const topicMatch = techOnly && category !== '科技' && technologyHeadline(title, column);
      if (techOnly && category !== '科技' && !topicMatch) continue;
      const year = url.match(/\/(20\d{2})\/\d{2}-\d{2}\//)?.[1];
      const publishedAt = year && `${year}-${stamp[1]}T${stamp[2]}:00+08:00`;
      if (!publishedAt || !validBeijingStamp(publishedAt) || !inRange(Date.parse(publishedAt), range)) continue;
      seen.add(url); out.push(item(source, { title, url, publishedAt, category: topicMatch ? '科技' : category, summary: '',
        ...(topicMatch ? { publisherColumn: column, categoryBasis: 'title_topic' } : {}) })); break;
    }
  }
  return { items: out, candidates: [] };
}
/** 新浪候选接口用首次ctime，不用mtime把旧稿刷成今日；彩票/赔率不是体育资讯。 */
export function parseSinaSports(json, source, { now = Date.now(), params = {} } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (data?.result?.status?.code !== 0 || !Array.isArray(data.result.data)) throw Object.assign(new Error('新浪返回结构不符'), { code: 'LOOKUP_PARSE' });
  const range = lookupTimeRange(params, now), out = [], seen = new Set();
  for (const row of data.result.data.slice(0, 150)) {
    const url = safeLink(row.url, source); const title = newsPlain(row.title || ''); const at = Number(row.ctime) * 1000;
    if (!url || seen.has(url) || /\/l\//.test(new URL(url).pathname) || /彩票|投注|胜负彩|欧赔|大乐透|双色球|竞彩|足彩/.test(title) || title.length < 8 || title.length > 180 || !inRange(at, range)) continue;
    seen.add(url); out.push(item(source, { title, url, publishedAt: beijingTime(at), summary: newsPlain(row.intro || '').slice(0, 350) }));
    if (out.length === 36) break;
  }
  return { items: out, candidates: [] };
}
/** 列表只用于找文章，URL的日期不能当作时间证据。 */
export function parseZhiboNewsIndex(html, source) {
  const candidates = [], seen = new Set();
  const clean = String(html).slice(0, 1024 * 1024).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const match of clean.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = safeLink(match[1], source), title = newsPlain(match[2]);
    if (!url || seen.has(url) || !/\/(?:zuqiu|nba)\/20\d{2}-\d{2}-\d{2}\/[^/]+\.htm$/.test(new URL(url).pathname) || title.length < 8 || title.length > 180) continue;
    seen.add(url); candidates.push({ title, url }); if (candidates.length === 12) break;
  }
  return { items: [], candidates };
}
export function parseZhiboNewsArticle(html, source, candidate, { now = Date.now(), params = {} } = {}) {
  const clean = String(html).slice(0, 1024 * 1024).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const stamp = clean.match(/<span\b[^>]*ms-controller=["']title_controller["'][^>]*>\s*(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i);
  const title = newsPlain(clean.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const body = clean.match(/<div\b[^>]*id=["']signals["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const publishedAt = stamp && `${stamp[1]}T${stamp[2]}+08:00`;
  if (!safeLink(candidate.url, source) || !title || !publishedAt || !validBeijingStamp(publishedAt) || !inRange(Date.parse(publishedAt), lookupTimeRange(params, now)) || !newsPlain(body).trim()) return [];
  return [item(source, { title: title.slice(0, 180), url: candidate.url, publishedAt, summary: newsPlain(body).slice(0, 350), verified: 'page', verification: 'page_read' })];
}
