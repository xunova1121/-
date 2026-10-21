/** 政府域名及已登记机构官网；不因页面标题含“官网”就信任任意网站。 */
const REGISTERED = new Set(['thecfa.cn', 'china-coop.org', 'sse.com.cn', 'szse.cn', 'cninfo.com.cn']);
const PROVINCES = { 江苏: 'jiangsu.gov.cn', 浙江: 'zj.gov.cn', 广东: 'gd.gov.cn', 北京: 'beijing.gov.cn', 上海: 'shanghai.gov.cn', 山东: 'shandong.gov.cn', 四川: 'sc.gov.cn' };
const under = (hostname, domain) => hostname === domain || hostname.endsWith('.' + domain);

export function isOfficialSource(address) {
  try {
    const parsed = new URL(address);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
    return under(parsed.hostname, 'gov.cn') || [...REGISTERED].some((domain) => under(parsed.hostname, domain));
  } catch { return false; }
}

export function mergeSearchHits(hits) {
  const unique = new Map();
  for (const hit of hits.slice(0, 300)) {
    try {
      const parsed = new URL(hit.url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) continue;
      parsed.hash = '';
      for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|spm$|from$)/i.test(key)) parsed.searchParams.delete(key);
      const key = parsed.href.replace(/\/$/, '');
      if (!unique.has(key)) unique.set(key, { ...hit, url: parsed.href });
    } catch { /* 非网址不能作为检索结果。 */ }
  }
  return [...unique.values()].map((hit, index) => ({ hit, index }))
    .sort((a, b) => Number(isOfficialSource(b.hit.url)) - Number(isOfficialSource(a.hit.url)) || a.index - b.index)
    .map(({ hit }) => hit);
}

/** 同一机构最多增加3种限定搜法；带site的请求不递归扩展。 */
export function officialQueries(query, hits) {
  if (/\bsite:/i.test(query) || !/机构|概况|职责|职能|政策|条例|办法|政府|官网|供销|合作总社|信息公开/.test(query)) return [];
  const sites = ['gov.cn'];
  for (const [province, domain] of Object.entries(PROVINCES)) if (query.includes(province)) sites.push(domain);
  const candidate = hits.find((hit) => isOfficialSource(hit.url));
  if (candidate) sites.push(new URL(candidate.url).hostname.replace(/^www\./, ''));
  return [...new Set(sites)].slice(0, 3).map((site) => `${query} site:${site}`);
}
