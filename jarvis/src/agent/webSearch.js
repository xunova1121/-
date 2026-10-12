/**
 * 联网搜索：
 *   - 填了 Tavily Key：用 Tavily（结果质量最好，带摘要）
 *   - 没填但有本机网关（完整版 / 桌面版）：经网关读取必应搜索结果页（国内外都能访问），失败再试 DuckDuckGo，免密钥
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

/**
 * @param {{ tavilyKey?: string, fetchViaGateway?: (url: string, init?: object) => Promise<Response> }} ctx
 * @returns {{ name: string, search: (query: string, n?: number) => Promise<Array<{title,url,snippet}>> } | null}
 */
export function createSearch({ tavilyKey, fetchViaGateway } = {}) {
  if (tavilyKey) {
    return {
      name: 'Tavily',
      async search(query, n = 6) {
        const url = 'https://api.tavily.com/search';
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: tavilyKey, query, max_results: n, include_answer: false }) };
        const res = fetchViaGateway ? await fetchViaGateway(url, init) : await fetch(url, init);
        if (!res.ok) throw new Error(`搜索服务返回 ${res.status}`);
        const j = await res.json();
        return (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 400) }));
      }
    };
  }
  if (!fetchViaGateway) return null;
  return {
    name: '必应',
    async search(query, n = 6) {
      const q = encodeURIComponent(query);
      const zh = /[一-鿿]/.test(query);
      const tries = [
        [`https://${zh ? 'cn.' : 'www.'}bing.com/search?q=${q}&count=${Math.max(10, n)}${zh ? '&setlang=zh-Hans' : ''}`, parseBing],
        [`https://html.duckduckgo.com/html/?q=${q}`, parseDuckDuckGo]
      ];
      // 一个来源结果太少（被拦、只有广告）时再查下一个，合并去重
      let lastErr = null;
      const hits = [];
      for (const [url, parse] of tries) {
        try {
          const res = await fetchViaGateway(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          for (const h of parse(await res.text())) if (!hits.some((x) => x.url === h.url)) hits.push(h);
          if (hits.length >= Math.min(3, n)) break;
        } catch (e) { lastErr = e; }
      }
      if (!hits.length && lastErr) throw new Error(`搜索失败（${lastErr.message}）。可在“模型”面板填 Tavily 搜索 Key（免费申请）获得更稳定的搜索`);
      return hits.slice(0, n);
    }
  };
}
