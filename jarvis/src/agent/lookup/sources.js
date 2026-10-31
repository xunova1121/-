import { DOMESTIC_NEWS_CANDIDATES } from './sourceCatalog.js';
import { internationalNewsFeeds } from '../newsFeeds.js';
import { parseNewsRss, verifiedReutersReprint } from '../newsRss.js';

export const LOOKUP_REGIONS = ['auto', 'cn', 'global'];
/** 时区用于选源偏好，不代表国内联网验收；未知时区保守优先国内，可在设置覆盖。 */
export function lookupRegion(value = 'auto', timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!LOOKUP_REGIONS.includes(value)) throw new Error('查询地区只接受auto、cn或global');
  return value === 'auto' ? !timezone || ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi', 'PRC'].includes(timezone) ? 'cn' : 'global' : value;
}

/** 原RSS/转载解析器保留；同媒体不同栏目各记健康，原始通讯社另用sourceFamily归组。 */
export function lookupSourceRegistry({ kind = 'news', params = {}, approvals = {} } = {}) {
  const categories = kind === 'sports_news' ? ['体育'] : params.categories || [];
  const publishers = params.publishers || [];
  const domestic = DOMESTIC_NEWS_CANDIDATES.filter(s => s.kind === kind)
    .filter(s => !publishers.length || publishers.includes(s.label) || publishers.includes(s.label.replace(/体育|新闻|候选/g, '')))
    .filter(s => !categories.length || s.category === '综合' || categories.includes(s.category));
  const international = categories.length === 1 && categories[0] === '国内' ? [] : internationalNewsFeeds(categories, publishers).map((feed, i) => ({
    ...feed, id: `global_${feed.id}_${{ 国际: 'world', 体育: 'sport', 财经: 'business', 科技: 'tech' }[feed.category]}`,
    kind, region: 'global', priority: 50 + i, timeoutMs: 8000, needsKey: false, validation: 'existing',
    parse: (body, source, { now }) => {
      const rows = parseNewsRss(body, source, now);
      return source.reprint ? { items: [], candidates: rows.filter(row => /^\/(?:world|asia|business|sport)\//.test(new URL(row.url).pathname)) } : { items: rows };
    },
    ...(feed.reprint ? { maxDetails: 3, parseArticle: (body, source, candidate, { now }) => {
      const item = verifiedReutersReprint(body, candidate, now);
      return item ? [{ ...item, verified: 'page' }] : [];
    } } : {})
  }));
  return [...domestic.map(source => {
    const approval = approvals[source.id];
    return approval ? { ...source, validation: approval.approved ? 'cn_verified' : 'not_selected', validationNote: approval.reason || approval.evidence, priority: approval.priority ?? source.priority } : source;
  }), ...international];
}

export async function selectLookupSources({ kind, params = {}, region = 'auto', timezone, health, sources = lookupSourceRegistry({ kind, params }), now = Date.now(), maxSources, signal, probeUnknown = false } = {}) {
  const selected = [], skipped = [];
  const resolvedRegion = lookupRegion(region, timezone);
  const limit = maxSources ?? (resolvedRegion === 'global' && kind === 'sports_news' ? 3 : 5);
  let probing = false;
  const candidates = [...sources].sort((a, b) => Number(a.region !== resolvedRegion) - Number(b.region !== resolvedRegion) || a.priority - b.priority);
  for (const source of candidates) {
    if (signal?.aborted) throw signal.reason;
    let reason = '';
    const recent = await health?.get(source.id);
    if (source.validation === 'pending_cn') reason = '国内网络尚未实测，未启用';
    else if (source.validation === 'not_selected') reason = source.validationNote;
    else if (recent?.cooling) reason = '连续失败后冷却30分钟，暂用其他来源';
    else if (resolvedRegion === 'cn' && source.region === 'global' && !(recent?.lastConnectedAt > now - 30 * 60 * 1000 && recent.lastConnectedAt <= now)) {
      const attempted = recent?.samples?.at(-1)?.at || 0;
      // 首次只试一个海外补充，仍计本轮8读和8秒，不另开隐形后台请求；失败30分钟内不再探测。
      if (probeUnknown && !probing && attempted <= now - 30 * 60 * 1000 && selected.length < limit) probing = true;
      else reason = '海外来源尚无近期连通记录，国内查询先用国内来源';
    }
    else if (selected.length >= Math.max(1, Math.min(7, limit))) reason = '本轮已选足优先来源';
    if (!reason && selected.length >= Math.max(1, Math.min(7, limit))) reason = '本轮已选足优先来源';
    if (reason) skipped.push({ source: source.id, label: source.label, reason });
    else selected.push(source);
  }
  return { region: resolvedRegion, sources: selected, skipped };
}
