import { createDeepseekSearch } from './deepseekSearch.js';
import { collectSearchSources, sourceQueue } from './searchSources.js';
import { mergeSearchHits, officialQueries } from './officialSources.js';
import { retryRead, throwControl, httpError } from '../core/networkRequest.js';
/**
 * 联网搜索：
 *   - 填了博查 Key：用博查（国内的 AI 搜索接口，中文结果好、稳定）
 *   - 填了 Tavily Key：用 Tavily（国外，英文结果好，带摘要）
 *   - 没填但能直接上网（桌面版经本机网关、手机 App 用系统网络）：读取搜索结果页，免密钥。
 *     先用必应的 RSS 结果（固定的 XML 格式，不受网页改版影响），不够再读网页：
 *     按网络判断地区：在国内（访问不了谷歌，或时区在中国）用必应中国、百度、360，在国外用必应、DuckDuckGo
 *     一条都没拿到时，报告每个来源的情况（HTTP 状态、是否验证页），方便查原因
 *   - 都没有：不提供搜索
 * 结果统一为 [{ title, url, snippet }]
 */
const decode = (s) => String(s)
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;|&ensp;/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

function b64url(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** 必应的跳转链接 bing.com/ck/a?…&u=a1<base64url> → 真实地址 */
export function unwrapBing(href) {
  try {
    const u = new URL(decode(href), 'https://www.bing.com');
    if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
      const p = u.searchParams.get('u');
      if (p?.startsWith('a1')) return b64url(p.slice(2));
    }
    return u.href;
  } catch { return null; }
}

export function parseBing(html) {
  const out = [];
  const blocks = String(html).split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = unwrapBing(a[1]);
    if (!url || !/^https?:/.test(url)) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || b.match(/class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    out.push({ title: decode(a[2]), url, snippet: decode(p?.[1] ?? '').replace(/^(\d{4}年\d{1,2}月\d{1,2}日|[A-Z][a-z]{2} \d{1,2}, \d{4})\s*[·\-–]\s*/, '') });
  }
  return out;
}

/** 必应 RSS（format=rss）：<item><title/><link/><description/></item> */
export function parseBingRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (n) => decode((m[1].match(new RegExp(`<${n}>([\\s\\S]*?)<\/${n}>`))?.[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    const url = tag('link');
    if (!/^https?:/.test(url)) continue;
    out.push({ title: tag('title'), url, snippet: tag('description').slice(0, 300) });
  }
  return out;
}

/** 必应 RSS 地址（地区、语言、时间筛选和网页版一样） */
export function bingRssUrl(query, region, freshness = '', now = Date.now()) {
  const q = encodeURIComponent(query);
  const zh = /[\u4e00-\u9fff]/.test(query);
  const host = region === 'cn' || zh ? 'cn.bing.com' : 'www.bing.com';
  const lang = zh ? '&setlang=zh-Hans' : region === 'cn' ? '&ensearch=1' : '';
  return `https://${host}/search?format=rss&q=${q}&count=10${lang}${freshParams(freshness, now).bing}`;
}

/** 搜不到时说清楚每个来源怎么了：被拦（验证页）、出错，还是页面里没认出结果 */
export function describeSource(name, status, body, hits) {
  const text = String(body ?? '');
  const kb = `${Math.max(1, Math.round(text.length / 1024))}KB`;
  const title = decode(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 30);
  if (/安全验证|验证码|人机验证|captcha|unusual traffic|异常访问|访问过于频繁/i.test(text)) return `${name}：被拦截（出现验证页${title ? `“${title}”` : ''}）`;
  if (status && status >= 400) return `${name}：HTTP ${status}`;
  return `${name}：${hits} 条（HTTP ${status || 200}，${kb}${title ? `，页面标题“${title}”` : ''}）`;
}

export function parseDuckDuckGo(html) {
  const out = [];
  const blocks = String(html).split(/class="[^"]*\bresult__body\b/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || b.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    try {
      const u = new URL(url, 'https://duckduckgo.com');
      url = u.searchParams.get('uddg') || u.href;
    } catch { continue; }
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue; // 广告
    const s = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|td|div)>/);
    out.push({ title: decode(a[2]), url, snippet: decode(s?.[1] ?? '') });
  }
  return out;
}

/** 百度：结果块的 mu 属性是真实地址（没有就用百度跳转链接，读网页时会自动跳转） */
export function parseBaidu(html) {
  const out = [];
  // 只按最外层结果块切（里面还嵌着 class 里也有 c-container 的 div）
  // 切出来的块以完整的开始标签开头（mu 属性在里面，位置不固定）
  const outer = /(?=<div\b[^>]*\bclass="[^"]*\bresult(?:-op)?\b[^"]*\bc-container\b)/;
  let blocks = String(html).split(outer).filter((b) => /^<div/.test(b));
  if (!blocks.length) blocks = String(html).split(/(?=<div\b[^>]*\bclass="[^"]*\bc-container\b)/).filter((b) => /^<div/.test(b));
  for (const b of blocks) {
    const a = b.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const head = b.slice(0, b.indexOf('>') + 1);
    const mu = decode(head.match(/\bmu="([^"]+)"/)?.[1] ?? '');
    const url = /^https?:/.test(mu) && !/nourl/.test(mu) ? mu : decode(a[1]);
    if (!/^https?:/.test(url) || /tuiguang|e\.baidu\.com/.test(url + head)) continue; // 推广
    const s = b.match(/class="[^"]*(?:c-abstract|content-right_[\w-]+|c-span-last|c-color-text)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/);
    const snippet = decode(s?.[1] ?? b.replace(a[0], '')).slice(0, 300);
    out.push({ title: decode(a[2]), url, snippet: snippet.replace(/^(\d{4}年\d{1,2}月\d{1,2}日)\s*/, '') });
  }
  return out;
}

/** 360 搜索：链接上的 data-mdurl 是真实地址 */
export function parseSo360(html) {
  const out = [];
  const blocks = String(html).split(/<li[^>]+class="[^"]*\bres-list\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const tag = b.match(/<h3[^>]*>[\s\S]*?(<a\b[^>]*>)([\s\S]*?)<\/a>/);
    if (!tag) continue;
    const attr = (n) => decode(tag[1].match(new RegExp(`\\b${n}="([^"]+)"`))?.[1] ?? '');
    const url = [attr('data-mdurl'), attr('data-url'), attr('href')].find((u) => /^https?:/.test(u) && !/so\.com\/link/.test(u)) || attr('href');
    if (!/^https?:/.test(url) || /e\.so\.com|ad\./.test(url)) continue;
    const s = b.match(/class="[^"]*(?:res-desc|res-comm-con|res-rich)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/);
    out.push({ title: decode(tag[2]), url, snippet: decode(s?.[1] ?? '').slice(0, 300) });
  }
  return out;
}

const CN_TZ = /^Asia\/(Shanghai|Chongqing|Chungking|Harbin|Urumqi|Kashgar)$/;
/**
 * 判断用国内还是国外的搜索源：先看网络（谷歌连不上 = 在国内网络里），再看时区。
 * @returns {Promise<'cn'|'global'>}
 */
export async function detectRegion(fetchImpl, { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, timeoutMs = 3500 } = {}) {
  const probe = Promise.race([
    fetchImpl('https://www.google.com/generate_204').then((r) => r.status === 204 || r.ok),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]).catch(() => false);
  if (!(await probe)) return 'cn';
  return CN_TZ.test(timeZone || '') ? 'cn' : 'global';
}

const FRESH_DAYS = { day: 1, week: 7, month: 30, year: 365 };

/**
 * 读搜索结果页时用电脑浏览器的请求头。手机 App 默认带手机浏览器的请求头，
 * 必应、百度、360 会返回手机版页面（结构完全不同），解析不出结果，表现为“什么都搜不到”。
 */
export const DESKTOP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

/** 只要最近一段时间的结果：各搜索源自己的时间筛选参数（不认识的参数各家会忽略） */
function freshParams(freshness, now) {
  const days = FRESH_DAYS[freshness];
  if (!days) return { bing: '', baidu: '', so: '', ddg: '' };
  const to = Math.floor(now / 1000), from = to - days * 86400;
  const d = (t) => Math.floor(t / 86400); // 必应自定义范围用“距 1970 年的天数”
  const bingCode = { day: 'ez1', week: 'ez2', month: 'ez3' }[freshness] || `ez5_${d(from)}_${d(to)}`;
  return {
    bing: `&filters=${encodeURIComponent(`ex1:"${bingCode}"`)}`,
    baidu: `&gpc=${encodeURIComponent(`stf=${from},${to}|stftype=1`)}`,
    so: `&adv_t=${freshness[0]}`,
    ddg: `&df=${freshness[0]}`
  };
}

/** 各地区用哪些搜索源；freshness：day / week / month / year 只要这段时间内的 */
export function searchPlan(query, region, freshness = '', now = Date.now()) {
  const q = encodeURIComponent(query);
  const zh = /[\u4e00-\u9fff]/.test(query);
  const f = freshParams(freshness, now);
  if (region === 'cn') {
    const baidu = ['百度', `https://www.baidu.com/s?wd=${q}&rn=10${f.baidu}`, parseBaidu];
    const so = ['360', `https://www.so.com/s?q=${q}${f.so}`, parseSo360];
    return zh
      ? [['必应中国', `https://cn.bing.com/search?q=${q}&count=10&setlang=zh-Hans${f.bing}`, parseBing], baidu, so]
      : [['必应中国（国际版）', `https://cn.bing.com/search?q=${q}&count=10&ensearch=1${f.bing}`, parseBing], baidu, so];
  }
  return [[zh ? '必应中国' : '必应', `https://${zh ? 'cn.' : 'www.'}bing.com/search?q=${q}&count=10${zh ? '&setlang=zh-Hans' : ''}${f.bing}`, parseBing], ['DuckDuckGo', `https://html.duckduckgo.com/html/?q=${q}${f.ddg}`, parseDuckDuckGo]];
}

/**
 * @param {{ bochaKey?: string, tavilyKey?: string, fetchViaGateway?: (url: string, init?: object) => Promise<Response>, searchRegion?: string }} ctx
 * @returns {{ name: string, search: (query: string, n?: number) => Promise<Array<{title,url,snippet}>> } | null}
 */
/** 各个搜索源（设置里“测试联网搜索”逐个测） */
export function searchEngines(options = {}) {
  const { bochaKey, tavilyKey, fetchViaGateway, searchRegion = 'auto' } = options;
  return [createDeepseekSearch(options), bochaKey && bochaSearch(bochaKey, fetchViaGateway), tavilyKey && tavilySearch(tavilyKey, fetchViaGateway), keylessSearch(fetchViaGateway, searchRegion)].filter(Boolean);
}

export function createSearch(options = {}) {
  const { bochaKey, tavilyKey, fetchViaGateway, searchRegion = 'auto' } = options;
  const deepseek = createDeepseekSearch(options);
  const keyless = keylessSearch(fetchViaGateway, searchRegion);
  const bocha = bochaKey ? bochaSearch(bochaKey, fetchViaGateway) : null;
  const tavily = tavilyKey ? tavilySearch(tavilyKey, fetchViaGateway) : null;
  const all = [deepseek, bocha, tavily, keyless].filter(Boolean);
  if (all.length <= 1) return all[0] ?? null;
  // 中文搜索词（国内用户）：博查 → 国内网站 → Tavily（Tavily 的中文结果多是港台和海外网站）；
  // 其他：Tavily → 博查 → 免密钥。前一个结果不够或出错时用后一个补上
  return {
    get name() { return all.map((e) => e.name).join(' + '); },
    regionNow: keyless?.regionNow,
    async search(query, n = 6, opts = {}) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const zh = /[\u4e00-\u9fff]/.test(query);
      const domestic = zh && (deepseek || !keyless || (await keyless.regionNow()) === 'cn');
      const order = [deepseek, ...(domestic ? [bocha, keyless, tavily] : [tavily, bocha, keyless])].filter(Boolean);
      const hits = [];
      const errors = [];
      for (const e of order) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        try {
          if (e === deepseek) opts.progress?.('正在调用DeepSeek搜索');
          // 同词换源不重复扣逻辑搜索预算。
          for (const h of await e.search(query, n, opts)) if (!hits.some((x) => x.url === h.url)) hits.push(h);
          if (e === deepseek) opts.progress?.(hits.length ? `DeepSeek搜索返回${hits.length}条结果` : 'DeepSeek搜索无结果，尝试原搜索线路');
        } catch (err) { throwControl(err, opts.signal); errors.push(err); if (e === deepseek) opts.progress?.('DeepSeek搜索未取得结果，尝试原搜索线路：' + err.message); }
        if (e === deepseek && hits.length || hits.length >= Math.min(3, n)) break;
      }
      if (!hits.length && errors.length) throw Object.assign(new Error(errors.map(error => error.message).join('；')), { cause: errors.at(-1), kind: errors.at(-1)?.kind, status: errors.at(-1)?.status, code: errors.at(-1)?.code, name: errors.at(-1)?.name });
      return hits.slice(0, n);
    }
  };
}

/** 博查（bochaai.com）：国内的网页搜索接口，按次计费，需要 Key */
const BOCHA_FRESH = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' };
function bochaSearch(key, fetchViaGateway) {
  return {
    name: '博查',
    async search(query, n = 6, { freshness = '', signal, consume } = {}) {
      const url = 'https://api.bochaai.com/v1/web-search';
      const init = { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ query, count: Math.min(10, Math.max(n, 5)), summary: true, freshness: BOCHA_FRESH[freshness] ?? 'noLimit' }) };
      const res = await retryRead(s => fetchViaGateway ? fetchViaGateway(url, { ...init, signal: s }) : fetch(url, { ...init, signal: s }), { signal, beforeAttempt: attempt => { if (attempt) consume?.('search'); } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || (j.code && j.code !== 200)) throw httpError(j.code || res.status, j.msg || '', '博查');
      return (j.data?.webPages?.value ?? []).map((r) => ({ title: r.name, url: r.url, snippet: String(r.summary || r.snippet || '').slice(0, 400) })).slice(0, n);
    }
  };
}

/** Tavily 出错时说人话 */
export function tavilyError(status, body = '') {
  const detail = String(body).match(/"(?:detail|error|message)"\s*:\s*(?:\{[^}]*"error"\s*:\s*)?"([^"]{1,120})"/)?.[1] ?? '';
  const why = status === 401 || status === 403 ? 'Key 无效或没生效（检查是否完整复制了 tvly- 开头的 Key）'
    : status === 429 ? '请求过于频繁或限流，不能据此判断余额' : status === 432 || status === 433 ? '服务账户或套餐受限，请核对服务商状态'
      : status >= 500 ? 'Tavily 服务暂时出错' : '';
  return `Tavily 返回 ${status}${why ? `：${why}` : ''}${detail ? `（${detail}）` : ''}`;
}

function tavilySearch(tavilyKey, fetchViaGateway) {
  return {
    name: 'Tavily',
    // deep：顺带要回网页正文（查证时不用再逐篇打开，手机上也不受跨域限制；仍是基础档，每次 1 个额度）
    async search(query, n = 6, { deep = false, freshness = '', signal, consume } = {}) {
      const url = 'https://api.tavily.com/search';
      // 密钥放请求头（Tavily 现在的写法），请求体里也带一份（兼容旧接口）
      const init = { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tavilyKey}` }, body: JSON.stringify({ api_key: tavilyKey, query, max_results: n, include_answer: false, ...(deep && { include_raw_content: true }), ...(FRESH_DAYS[freshness] && { time_range: freshness }) }) };
      const res = await retryRead(s => fetchViaGateway ? fetchViaGateway(url, { ...init, signal: s }) : fetch(url, { ...init, signal: s }), { signal, beforeAttempt: attempt => { if (attempt) consume?.('search'); } }).catch(error => { throwControl(error, signal); throw Object.assign(new Error('连不上 Tavily（' + error.message + '）'), { kind: error.kind, code: error.code, name: error.name, cause: error }); });
      if (!res.ok) throw httpError(res.status, tavilyError(res.status, await res.text().catch(() => '')), 'Tavily');
      const j = await res.json();
      return (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 400), ...(r.raw_content && { raw: String(r.raw_content).slice(0, 12000) }) }));
    }
  };
}

function keylessSearch(fetchViaGateway, searchRegion) {
  if (!fetchViaGateway) return null;
  const schedule = sourceQueue();
  // 地区：用户指定的，或自动判断（结果记 30 分钟：开关代理后会重新判断）
  let region = searchRegion === 'cn' || searchRegion === 'global' ? searchRegion : null;
  let checkedAt = 0;
  const regionNow = async () => {
    if (searchRegion === 'cn' || searchRegion === 'global') return searchRegion;
    if (!region || Date.now() - checkedAt > 30 * 60e3) { region = await detectRegion(fetchViaGateway); checkedAt = Date.now(); }
    return region;
  };
  return {
    get name() { return region === 'cn' ? '必应中国、百度、360（国内）' : region === 'global' ? '必应、DuckDuckGo' : '按网络自动选择（国内：必应中国、百度、360；国外：必应、DuckDuckGo）'; },
    regionNow,
    async search(query, n = 6, { freshness = '', signal, consume } = {}) {
      const region = await regionNow();
      const plan = [['必应 RSS', bingRssUrl(query, region, freshness), parseBingRss], ...searchPlan(query, region, freshness)];
      const run = (selected) => collectSearchSources(selected, { get: fetchViaGateway, headers: DESKTOP_HEADERS, signal, describe: describeSource, schedule });
      const chinese = /[\u4e00-\u9fff]/.test(query);
      // 中文至少同时查RSS和百度，不能因RSS已有4条就停；其他来源只在不足时补充。
      const primary = chinese ? [plan[0], ['百度', `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=10${freshParams(freshness, Date.now()).baidu}`, parseBaidu]] : [plan[0]];
      const first = await run(primary);
      let hits = first.hits;
      const notes = first.notes;
      let lastError = first.error;
      if (hits.length < Math.min(4, n)) {
        const fallback = await run(plan.slice(1).filter(([sourceName]) => !chinese || sourceName !== '百度'));
        hits = mergeSearchHits([...hits, ...fallback.hits]);
        notes.push(...fallback.notes);
        lastError = fallback.error || lastError;
      }
      for (const restricted of officialQueries(query, hits)) {
        if (signal?.aborted) throw signal.reason;
        consume?.('search');
        const extra = await run([['必应 RSS', bingRssUrl(restricted, region, freshness), parseBingRss], ['百度', `https://www.baidu.com/s?wd=${encodeURIComponent(restricted)}&rn=10`, parseBaidu]]);
        hits = mergeSearchHits([...hits, ...extra.hits]);
        notes.push(...extra.notes);
        lastError = extra.error || lastError;
      }
      if (!hits.length) throw Object.assign(new Error('各搜索源都没拿到结果——' + notes.join('；') + '。请换搜法或来源；免密钥搜索不需要购买第三方API'), { code: lastError?.code || 'NO_SEARCH_RESULTS', kind: lastError?.kind, name: lastError?.name || 'SearchError', cause: lastError });
      return hits.slice(0, n);
    }
  };
}

