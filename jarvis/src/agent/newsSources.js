/** 站点专用解析器。只取实际HTML里的条目和时间；链接路径只能补足年份，不能替代发布时间。 */
export const NEWS_SOURCES = [
  { id: 'cnfin', label: '新华财经', url: 'https://www.cnfin.com/news/index.html', category: '财经' },
  { id: 'cnr', label: '央广网', url: 'https://news.cnr.cn/native/gd/', category: '国内' },
  { id: 'cns', label: '中新网', url: 'https://www.chinanews.com.cn/scroll-news/news1.html', category: '综合' }
];
export const newsDate = now => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
export const newsPlain = text => String(text).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
  const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&(?:nbsp|ensp|emsp);/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function link(chunk, base) {
  const matches = [...chunk.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of matches) {
    try {
      const url = new URL(newsPlain(m[1]), base);
      const title = newsPlain(m[2].replace(/<em\b[^>]*>[\s\S]*?<\/em>/gi, '').replace(/<span\b[^>]*class=["']publishTime["'][^>]*>[\s\S]*?<\/span>/gi, ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 1200 || title.length < 8 || title.length > 180) continue;
      return { url: url.href, title };
    } catch { /* 非链接内容不变成来源。 */ }
  }
  return null;
}
export function parseNewsSource(html, source, now = Date.now()) {
  const date = newsDate(now);
  const clean = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const chunks = source.id === 'cnfin' ? clean.split(/<div\b[^>]*class=["']ui-zxlist-item["'][^>]*>/i).slice(1)
    : source.id === 'cnr' ? clean.split(/<div\b[^>]*class=["']item url_http["'][^>]*>/i).slice(1)
    : [...clean.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  const out = [], seen = new Set();
  for (const raw of chunks.slice(0, 150)) {
    const chunk = raw.slice(0, 12000);
    const item = link(chunk, source.url);
    if (!item || seen.has(item.url)) continue;
    const stamp = source.id === 'cns' ? chunk.match(/class=["']dd_time["'][^>]*>\s*(\d{2}-\d{2})\s+(\d{2}:\d{2})/i)
      : chunk.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
    if (!stamp) continue;
    const year = source.id === 'cns' ? item.url.match(/\/(20\d{2})\/\d{2}-\d{2}\//)?.[1] : '';
    const day = source.id === 'cns' ? year && year + '-' + stamp[1] : stamp[1];
    if (day !== date) continue;
    const publishedAt = day + 'T' + stamp[2] + (stamp[2].length === 5 ? ':00' : '') + '+08:00';
    if (!Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > now) continue;
    const snippet = source.id === 'cnfin' ? chunk.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      : source.id === 'cnr' ? chunk.match(/<em\b[^>]*>([\s\S]*?)<\/em>/i)?.[1] : '';
    const column = newsPlain(chunk.match(/class=["']dd_lm["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    const category = source.id !== 'cns' ? source.category : /国际/.test(column) || /\/gj\//.test(item.url) ? '国际' : /财经/.test(column) || /\/cj\//.test(item.url) ? '财经' : /科技/.test(column) || /\/it\//.test(item.url) ? '科技' : /国内|时政|社会/.test(column) || /\/gn\//.test(item.url) ? '国内' : '其他';
    seen.add(item.url);
    out.push({ ...item, summary: newsPlain(snippet || '').slice(0, 350), publishedAt, category, source: source.label, indexUrl: source.url, verification: 'index_only' });
    if (out.length === 36) break;
  }
  return out;
}
