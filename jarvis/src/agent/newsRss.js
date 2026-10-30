import { newsDate, newsPlain } from './newsSources.js';

const field = (text, tag) => {
  const value = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '';
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
};
export const beijingNewsTime = ms => new Date(ms + 28800000).toISOString().slice(0, 19) + '+08:00';
/** 不执行XML实体、外部DTD或脚本；只读有界RSS条目与发布者明确给出的日期。 */
export function parseNewsRss(xml, source, now = Date.now()) {
  const clean = String(xml).slice(0, 800 * 1024);
  if (/<!DOCTYPE|<!ENTITY/i.test(clean)) return [];
  const out = [], seen = new Set();
  for (const match of clean.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    if (out.length >= 36) break;
    const item = match[1].slice(0, 16000);
    const title = newsPlain(field(item, 'title')).slice(0, 180);
    const rawDate = newsPlain(field(item, 'pubDate'));
    // 缺时区不猜服务器所在时区；RSS日期按其真实时区转北京时间，拒绝未来/旧闻。
    if (!/(?:GMT|UTC|[+-]\d{2}:?\d{2}|Z)\s*$/i.test(rawDate)) continue;
    const at = Date.parse(rawDate);
    if (!Number.isFinite(at) || at > now || newsDate(at) !== newsDate(now)) continue;
    let url;
    try {
      url = new URL(newsPlain(field(item, 'link')));
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !source.hosts.includes(url.hostname) || url.href.length > 1200 || seen.has(url.href)) continue;
    } catch { continue; }
    if (title.length < 8) continue;
    seen.add(url.href);
    const byline = newsPlain(field(item, 'dc:creator') || field(item, 'author'));
    out.push({ title, url: url.href, summary: newsPlain(field(item, 'description')).slice(0, 350), publishedAt: beijingNewsTime(at), category: source.category,
      source: source.reprint ? 'CNA（来源待核对）' : source.label, sourceFamily: source.reprint ? 'unverified' : /^(?:Reuters|路透)(?:\s|$)/i.test(byline) ? 'reuters' : source.family,
      publisher: source.reprint ? 'CNA' : source.label, indexUrl: source.url, verification: 'index_only' });
  }
  return out;
}

/** 仅认文章自己的来源栏与匹配URL的NewsArticle日期，不把照片水印/提及Reuters当作转载署名。 */
export function verifiedReutersReprint(html, item, now = Date.now()) {
  const clean = String(html).slice(0, 800 * 1024);
  const visible = clean.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const source = [...new Set([...visible.matchAll(/<div\b[^>]*class=["'][^"']*\bsource\b[^"']*["'][^>]*>([\s\S]{0,500}?)<\/div>/gi)].map(m => newsPlain(m[1])))];
  if (source.length !== 1 || !/^Source:\s*Reuters(?:\/[\w-]+)?\s*$/i.test(source[0])) return null;
  for (const match of clean.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].length > 200000) continue;
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const queue = [data]; let visited = 0;
    while (queue.length && visited++ < 64) {
      const value = queue.shift();
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) { queue.push(...value.slice(0, 32)); continue; }
      const types = [value['@type']].flat();
      if (types.some(t => /^(?:NewsArticle|Article|ReportageNewsArticle)$/.test(t))) {
        const articleUrl = value.url || (typeof value.mainEntityOfPage === 'string' ? value.mainEntityOfPage : value.mainEntityOfPage?.['@id']);
        const at = Date.parse(value.datePublished);
        if (articleUrl === item.url && Number.isFinite(at) && at <= now && newsDate(at) === newsDate(now)) return { ...item, source: '路透（CNA转载）', sourceFamily: 'reuters', publishedAt: beijingNewsTime(at), timeBasis: 'CNA转载页发布时间', reprint: true, attributionVerified: true };
      }
      for (const child of Object.values(value).slice(0, 32)) if (child && typeof child === 'object' && queue.length < 64) queue.push(child);
    }
  }
  return null;
}

/** 仅提供相同标题的待审线索；跨语言归组由既有回答模型判断，不预设已交叉核实。 */
export function newsCoverage(items) {
  const groups = new Map();
  items.forEach((item, i) => {
    const key = item.title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
    if (key.length < 16 || /早报|晚报|新闻简报|newsbrief|dailybrief/.test(key)) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return { publishers: [...new Set(items.map(i => i.publisher || i.source))], originFamilies: [...new Set(items.map(i => i.sourceFamily || i.source))],
    titleMatchCandidates: [...groups.values()].filter(ids => ids.length > 1).slice(0, 12), crossChecked: false,
    rule: '媒体数量不等于独立核实；同一通讯社的转载只算一个原始来源。标题匹配仅为候选，同一事件须核对主体、地点和时间；不合并冲突数字。' };
}
