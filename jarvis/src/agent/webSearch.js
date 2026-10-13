/**
 * 联网搜索：
 *   - 填了 Tavily Key：用 Tavily（结果质量最好，带摘要）
 *   - 没填但能直接上网（桌面版经本机网关、手机 App 用系统网络）：读取搜索结果页，免密钥。
 *     按网络判断地区：在国内（访问不了谷歌，或时区在中国）用必应中国、百度、360，在国外用必应、DuckDuckGo
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

/** 各地区用哪些搜索源 */
export function searchPlan(query, region) {
  const q = encodeURIComponent(query);
  const zh = /[\u4e00-\u9fff]/.test(query);
  if (region === 'cn') {
    return zh
      ? [['必应中国', `https://cn.bing.com/search?q=${q}&count=10&setlang=zh-Hans`, parseBing], ['百度', `https://www.baidu.com/s?wd=${q}&rn=10`, parseBaidu], ['360', `https://www.so.com/s?q=${q}`, parseSo360]]
      : [['必应中国（国际版）', `https://cn.bing.com/search?q=${q}&count=10&ensearch=1`, parseBing], ['百度', `https://www.baidu.com/s?wd=${q}&rn=10`, parseBaidu], ['360', `https://www.so.com/s?q=${q}`, parseSo360]];
  }
  return [[zh ? '必应中国' : '必应', `https://${zh ? 'cn.' : 'www.'}bing.com/search?q=${q}&count=10${zh ? '&setlang=zh-Hans' : ''}`, parseBing], ['DuckDuckGo', `https://html.duckduckgo.com/html/?q=${q}`, parseDuckDuckGo]];
}

/**
 * @param {{ tavilyKey?: string, fetchViaGateway?: (url: string, init?: object) => Promise<Response> }} ctx
 * @returns {{ name: string, search: (query: string, n?: number) => Promise<Array<{title,url,snippet}>> } | null}
 */
export function createSearch({ tavilyKey, fetchViaGateway, searchRegion = 'auto' } = {}) {
  const keyless = keylessSearch(fetchViaGateway, searchRegion);
  const tavily = tavilyKey ? tavilySearch(tavilyKey, fetchViaGateway) : null;
  if (tavily && keyless) {
    // 国内用户：中文搜索词走国内网站（Tavily 的中文结果多是港台和海外网站），其余走 Tavily；一边没结果再试另一边
    return {
      get name() { return `Tavily + ${keyless.name}`; },
      regionNow: keyless.regionNow,
      async search(query, n = 6, opts = {}) {
        const domestic = /[\u4e00-\u9fff]/.test(query) && (await keyless.regionNow()) === 'cn';
        const [first, second] = domestic ? [keyless, tavily] : [tavily, keyless];
        const hits = await first.search(query, n, opts).catch(() => []);
        return hits.length >= Math.min(3, n) ? hits : [...hits, ...(await second.search(query, n, opts).catch(() => []))].filter((h, i, a) => a.findIndex((x) => x.url === h.url) === i).slice(0, n);
      }
    };
  }
  return tavily || keyless;
}

function tavilySearch(tavilyKey, fetchViaGateway) {
  return {
    name: 'Tavily',
    // deep：顺带要回网页正文（查证时不用再逐篇打开，手机上也不受跨域限制；仍是基础档，每次 1 个额度）
    async search(query, n = 6, { deep = false } = {}) {
      const url = 'https://api.tavily.com/search';
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: tavilyKey, query, max_results: n, include_answer: false, ...(deep && { include_raw_content: true }) }) };
      const res = fetchViaGateway ? await fetchViaGateway(url, init) : await fetch(url, init);
      if (!res.ok) throw new Error(`搜索服务返回 ${res.status}`);
      const j = await res.json();
      return (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 400), ...(r.raw_content && { raw: String(r.raw_content) }) }));
    }
  };
}

function keylessSearch(fetchViaGateway, searchRegion) {
  if (!fetchViaGateway) return null;
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
    async search(query, n = 6) {
      const plan = searchPlan(query, await regionNow());
      // 一个来源结果太少（被拦、只有广告）时再查下一个，合并去重
      let lastErr = null;
      const hits = [];
      for (const [, url, parse] of plan) {
        try {
          const res = await fetchViaGateway(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          for (const h of parse(await res.text())) if (!hits.some((x) => x.url === h.url)) hits.push(h);
          if (hits.length >= Math.min(4, n)) break;
        } catch (e) { lastErr = e; }
      }
      if (!hits.length && lastErr) throw new Error(`搜索失败（${lastErr.message}）。可在“模型”面板填 Tavily 搜索 Key（免费申请）获得更稳定的搜索`);
      return hits.slice(0, n);
    }
  };
}
