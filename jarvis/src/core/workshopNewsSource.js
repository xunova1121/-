import { withWebDeadline } from '../agent/lookup/request.js';
import { decodeLookupBody } from '../agent/lookup/content.js';
import { parseCnsRolling } from '../agent/lookup/domesticNews.js';
import { NEWS_SOURCES, newsPlain } from '../agent/newsSources.js';
import { webBody } from '../agent/webBody.js';

// 央视网新闻首页公开使用的首屏列表。仅解析 JSONP 的 JSON 参数，绝不运行网页脚本。
export const CCTV_NEWS_INDEX = 'https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/news_1.jsonp';
const cns = { ...NEWS_SOURCES.find(src => src.id === 'cns'), kind: 'news', hosts: ['www.chinanews.com.cn'] };
const day = 24 * 60 * 60 * 1000;
export const NEWS_REFRESH_MS = 15 * 60 * 1000;

// 涵盖离线数据和网关回执，只保留用户能打开的原媒体 HTTPS 文章，不保留正文或追踪参数。
function articleLink(value, source) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 1200) return '';
    if (source === '央视网' && /^(?:news|jingji|photo|tv|sports|military|tech|agri|travel|culture)\.cctv\.com$/.test(url.hostname) && /^\/20\d{2}\/\d{2}\/\d{2}\/[\w-]+\.shtml$/.test(url.pathname) ||
        source === cns.label && cns.hosts.includes(url.hostname) && /\/20\d{2}\/\d{2}-\d{2}\/\d+\.shtml$/.test(url.pathname)) return url.origin + url.pathname;
  } catch { /* 跳过无效的地址。 */ }
  return '';
}

export function workshopHeadlines(items, at) {
  if (!Array.isArray(items)) return [];
  const rows = new Map();
  for (const row of items.slice(0, 100)) {
    if (!row || typeof row.title !== 'string') continue;
    const url = articleLink(row.url, row.source);
    const stamp = Date.parse(row.publishedAt);
    const title = newsPlain(row.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!url || !title || title.length > 180 || !Number.isFinite(stamp) || stamp > at || stamp < at - day || rows.has(url)) continue;
    rows.set(url, { title, url, source: row.source, publishedAt: new Date(stamp).toISOString() });
  }
  return [...rows.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 12);
}

function cctvItems(text) {
  const wrapper = /^\s*news\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text);
  if (!wrapper) return [];
  const rows = JSON.parse(wrapper[1])?.data?.list;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).flatMap(row => {
    const stamp = row?.focus_date;
    if (typeof stamp !== 'string' || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)) return [];
    const publishedAt = stamp.replace(' ', 'T') + '+08:00';
    const timestamp = Date.parse(publishedAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 19) !== stamp.replace(' ', 'T')) return [];
    return [{ title: row.title, url: row.url, source: '央视网', publishedAt }];
  });
}

// 一个固定主源，失败时再读一个备用源。每源含正文的总期限 5 秒，无模型、搜索或第三方中转。
export async function readWorkshopHeadlines({ get, signal, now = Date.now }) {
  for (const url of [CCTV_NEWS_INDEX, cns.url]) {
    try {
      const result = await withWebDeadline(async active => {
        const response = await get(url, { signal: active, credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error('新闻来源暂不可用');
        const bytes = await webBody(response, 900 * 1024, active);
        const text = decodeLookupBody(bytes, response.headers.get('content-type') || '');
        const updatedAt = now();
        const rows = url === CCTV_NEWS_INDEX ? cctvItems(text) : parseCnsRolling(text, cns, { now: updatedAt, params: { dateMode: 'recent24h' } }).items;
        return { items: workshopHeadlines(rows, updatedAt), updatedAt, stale: false };
      }, { signal, timeoutMs: 5000 });
      if (result.items.length) return result;
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
    }
  }
  throw Object.assign(new Error('暂时没取到近 24 小时的新闻'), { code: 'WORKSHOP_NEWS_UNAVAILABLE' });
}
