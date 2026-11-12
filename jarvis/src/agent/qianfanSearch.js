/** 百度官方网页搜索：仅固定端点，摘要与已读原文分开；不读取或回显上游错误正文。 */
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl, httpError } from '../core/networkRequest.js';
import { webBody } from './webBody.js';
import { isPrivateHost } from '../../shared/providers.js';
import { newsDate, newsPlain } from './newsSources.js';
import { DOMESTIC_NEWS_CANDIDATES } from './lookup/sourceCatalog.js';
import { internationalNewsFeeds } from './newsFeeds.js';
import { mergeSearchHits } from './officialSources.js';
import { searchBackoff, searchRetryAfter } from './searchPolicy.js';
import { localLookupFailure } from './lookup/healthPolicy.js';

export const QIANFAN_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const secret = value => typeof value === 'string' && !value.startsWith('••••') ? value.trim() : '';
const clean = value => newsPlain(String(value || '')).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const validDay = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};

export function searchDate(query, freshness, now = Date.now()) {
  const explicit = String(query).match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if (explicit) {
    const day = `${explicit[1]}-${explicit[2].padStart(2, '0')}-${explicit[3].padStart(2, '0')}`;
    if (validDay(day)) return day;
  }
  return freshness === 'day' || /今天|今日|刚才|最新|实时/.test(query) ? newsDate(now) : null;
}

export function qianfanPublishedAt(value) {
  const raw = String(value || '').trim();
  if (validDay(raw)) return raw;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) || !validDay(raw.slice(0, 10))) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw.replace(' ', 'T') : raw.replace(' ', 'T') + '+08:00';
  const stamp = Date.parse(withZone);
  return Number.isFinite(stamp) ? new Date(stamp + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00' : null;
}

export function qianfanSites(query) {
  const explicit = [...String(query).matchAll(/\bsite:([a-z0-9.-]+)/gi)].map(match => match[1]);
  const named = [...DOMESTIC_NEWS_CANDIDATES, ...internationalNewsFeeds([], ['BBC', '路透', '卫报', '半岛电视台'])]
    .filter(source => String(query).includes(source.label.replace(/新闻|候选|体育/g, '')))
    .flatMap(source => source.hosts || [new URL(source.url).hostname]);
  // 用户显式点名的网站，不把同集团的财经站冒充新华网。
  if (/新华网/.test(query)) named.push('news.cn', 'xinhuanet.com');
  if (/直播吧/.test(query)) named.push('zhibo8.com');
  return [...new Set([...explicit, ...named])].filter(host => /^(?=.{1,253}$)[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) && !isPrivateHost(host)).slice(0, 8);
}

export function qianfanRequest(query, { topK = 10, freshness, edition = 'standard', now = Date.now(), sites, requestText = '' } = {}) {
  const text = String(query).trim().slice(0, 1000);
  if (!text) throw Object.assign(new Error('请提供搜索词'), { code: 'QIANFAN_QUERY', kind: 'api' });
  const day = searchDate(requestText, undefined, now) || searchDate(text, freshness, now);
  const filteredSites = sites || qianfanSites(requestText + ' ' + text);
  const filter = {};
  if (filteredSites.length) filter.match = { site: filteredSites };
  if (day) filter.range = { page_time: { gte: day, lt: new Date(Date.parse(day + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10) } };
  const recency = !day && (freshness || (/新闻|资讯|体育/.test(text) ? 'week' : ''));
  return {
    messages: [{ role: 'user', content: text }], search_source: 'baidu_search_v2', edition: edition === 'lite' ? 'lite' : 'standard',
    resource_type_filter: [{ type: 'web', top_k: Number.isFinite(topK) ? Math.max(5, Math.min(20, Math.floor(topK))) : 10 }],
    block_websites: ['espn.com', 'espn.com.cn', 'espn.co.uk', 'espn.in'],
    ...(Object.keys(filter).length && { search_filter: filter }),
    ...(['week', 'month', 'year'].includes(recency) && { search_recency_filter: recency })
  };
}

/** 明确错日的结果直接丢弃；日期未知只能作为相关线索，不能当成指定日的事实。 */
export function datedSearchHits(hits, query, { freshness, now = Date.now(), requestText = '' } = {}) {
  const day = searchDate(requestText, undefined, now) || searchDate(query, freshness, now);
  if (!day) return hits;
  return hits.flatMap(hit => {
    const titleDates = [...String(hit.title || '').matchAll(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/g)]
      .map(match => `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
    const published = qianfanPublishedAt(hit.publishedAt);
    if (titleDates.some(value => value !== day) || published && published.slice(0, 10) !== day) return [];
    if (day === newsDate(now) && published?.length > 10 && Date.parse(published) > now) return [];
    return [{ ...hit, publishedAt: published, dateStatus: published ? 'matched' : 'unknown' }];
  });
}

export function formatSearchHit(hit, { query = '', requestText = '', freshness } = {}) {
  const provider = hit.source === 'qianfan' ? '百度搜索' : hit.source === 'deepseek' ? 'DeepSeek检索' : hit.source === 'openai-compatible' ? '自定义联网搜索' : '';
  const publication = qianfanPublishedAt(hit.publishedAt);
  const constrained = searchDate(requestText, freshness) || searchDate(query, freshness);
  const evidence = hit.source === 'openai-compatible' && hit.evidenceType === 'provider_citation'
    ? hit.summaryEvidence === 'provider_cited_summary' ? '模型带引文摘要，未读原文' : '来源链接，待打开原文核实'
    : '摘要，未读原文';
  const label = provider ? `\n  （${provider}${evidence}）` : '';
  const date = publication ? ' 发布时间：' + publication + '（北京时间）' : provider ? ' 日期未知' : '';
  const uncertain = constrained && !publication ? '\n  （可能相关、日期未核实，不能作为指定日期的事实）' : '';
  return `- ${hit.title}\n  ${hit.url}\n  ${String(hit.snippet || '').slice(0, provider ? 800 : 300)}${label}${date}${uncertain}`;
}

export function createQianfanSearch({ qianfanSearchKey, qianfanSearchTopK = 10, fetchViaGateway, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  const key = secret(qianfanSearchKey);
  if (!key) return null;
  const get = fetchViaGateway || fetchImpl;
  let unavailableUntil = 0;
  return {
    name: '百度千帆搜索',
    async search(query, count = 10, options = {}) {
      if (unavailableUntil > now()) throw Object.assign(new Error('百度搜索短暂退避，先用其他来源'), { code: 'QIANFAN_UNAVAILABLE', kind: 'api', skipped: true });
      try {
        const request = qianfanRequest(query, { ...options, topK: options.topK ?? qianfanSearchTopK, now: now() });
        const data = await withWebDeadline(async signal => {
          let response;
          try { response = await get(QIANFAN_ENDPOINT, { method: 'POST', redirect: 'error', signal, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(request) }); }
          catch (failure) {
            throwControl(failure, signal);
            if (localLookupFailure(failure)) throw failure;
            if (['EVAL_QUOTA', 'EVAL_EXPIRED'].includes(failure.code)) throw failure;
            throw Object.assign(new Error('百度搜索网络连接失败'), { kind: 'network', code: 'QIANFAN_NETWORK' });
          }
          if (!response.ok) {
            await response.body?.cancel?.();
            const detail = [401, 403].includes(response.status) ? 'Key无效、无权访问或未生效，请核对服务器设置' : [402, 429].includes(response.status) ? '额度不足或服务商限流，请核对服务商账户' : '服务暂时不可用';
            throw Object.assign(httpError(response.status, detail, '百度搜索'), { retryAfterMs: searchRetryAfter(response, now()) });
          }
          const bytes = await webBody(response, 2 * 1024 * 1024, signal);
          let parsed;
          try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* 受控格式错误，不回显响应。 */ }
          if (!Array.isArray(parsed?.references)) throw Object.assign(new Error('百度搜索未返回有效references列表，请核对服务商接口'), { kind: 'api', code: 'QIANFAN_FORMAT' });
          return parsed;
        }, { signal: options.signal, timeoutMs: 8000 });
        const rows = data.references.slice(0, 100).flatMap(item => {
          try {
            const url = new URL(String(item.url || ''));
            if (!/^https?:$/.test(url.protocol) || url.username || url.password || isPrivateHost(url.hostname) || /(?:^|\.)espn\.(?:com|com\.cn|co\.uk|in)$/.test(url.hostname) || url.href.includes(key) || item.type && item.type !== 'web') return [];
            const redact = text => clean(text).split(key).join('[已隐藏]');
            const title = redact(item.title).slice(0, 200);
            if (!title) return [];
            return [{ title, url: url.href, snippet: redact(item.content || item.snippet).slice(0, 800), publishedAt: qianfanPublishedAt(item.date), source: 'qianfan' }];
          } catch { return []; }
        });
        return datedSearchHits(mergeSearchHits(rows), query, { freshness: options.freshness, requestText: options.requestText, now: now() }).slice(0, Math.max(1, Math.min(20, count)));
      } catch (failure) {
        throwControl(failure, options.signal);
        if (['EVAL_QUOTA', 'EVAL_EXPIRED'].includes(failure.code)) throw failure;
        const delay = searchBackoff(failure);
        if (delay) unavailableUntil = now() + delay;
        throw failure;
      }
    }
  };
}

export async function testQianfanSearch(cfg, { signal, fetchViaGateway } = {}) {
  const service = createQianfanSearch({ ...cfg, fetchViaGateway });
  if (!service) throw Object.assign(new Error('请先保存百度千帆搜索Key'), { code: 'QIANFAN_KEY_MISSING', kind: 'api' });
  const start = performance.now();
  const hits = await service.search('今日新闻', 10, { freshness: 'day', signal });
  return { provider: 'qianfan', ms: Math.round(performance.now() - start), count: hits.length, requests: 1, sample: hits.slice(0, 3).map(row => ({ title: row.title, publishedAt: row.publishedAt, domain: new URL(row.url).hostname })) };
}
