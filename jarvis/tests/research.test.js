import { describe, it, expect } from 'vitest';
import { parseBing, parseDuckDuckGo, unwrapBing, createSearch, parseBingRss, bingRssUrl, searchEngines } from '../src/agent/webSearch.js';
import { deepResearch, parseJson, extractive } from '../src/agent/research.js';

const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const BING = `<ol id="b_results">
<li class="b_algo" data-id=""><div class="b_tpcn"></div><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${b64('https://ollama.com/library/qwen3')}&amp;ntb=1" h="ID=SERP">Qwen3 &amp; Ollama <strong>library</strong></a></h2>
<div class="b_caption"><p class="b_lineclamp2">2025年4月29日 · Qwen3 is the latest generation of large language models in Qwen series.</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/a?x=1&amp;y=2">Example &#39;A&#39;</a></h2><div class="b_caption"><p>Snippet A</p></div></li>
<li class="b_ad"><h2><a href="https://ad.example">广告</a></h2></li>
</ol>`;

const DDG = `<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Follama%2Follama&amp;rut=abc">ollama/ollama: Get up and running</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Get up and running with <b>Llama</b> 3.3, Qwen3…</a></div></div>
<div class="result results_links result--ad"><div class="links_main result__body"><h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">ad</a></h2></div></div>`;

describe('免密钥搜索结果解析', () => {
  it('必应：解开跳转链接、去掉 HTML 和日期前缀、跳过广告', () => {
    const r = parseBing(BING);
    expect(r).toEqual([
      { title: 'Qwen3 & Ollama library', url: 'https://ollama.com/library/qwen3', snippet: 'Qwen3 is the latest generation of large language models in Qwen series.' },
      { title: "Example 'A'", url: 'https://example.com/a?x=1&y=2', snippet: 'Snippet A' }
    ]);
    expect(unwrapBing('https://www.bing.com/ck/a?u=a1' + b64('https://中文.example/路径'))).toBe('https://中文.example/路径');
  });
  it('DuckDuckGo：解开 uddg、跳过广告', () => {
    expect(parseDuckDuckGo(DDG)).toEqual([{ title: 'ollama/ollama: Get up and running', url: 'https://github.com/ollama/ollama', snippet: 'Get up and running with Llama 3.3, Qwen3…' }]);
  });
  it('选择搜索源：Tavily > 网关（必应 → DuckDuckGo）> 无', async () => {
    expect(createSearch({})).toBeNull();
    expect(createSearch({ tavilyKey: 'k' }).name).toBe('Tavily');
    const asked = [];
    const s = createSearch({ searchRegion: 'global', fetchViaGateway: async (url) => { asked.push(url); return new Response(/bing/.test(url) ? '<html>验证</html>' : DDG); } });
    const hits = await s.search('ollama 本机模型');
    expect(asked[0]).toMatch(/^https:\/\/cn\.bing\.com\/search\?format=rss&q=ollama/); // 先用必应 RSS
    expect(asked[1]).toMatch(/^https:\/\/cn\.bing\.com\/search\?q=ollama/);
    expect(asked[2]).toMatch(/duckduckgo/);
    expect(hits[0].url).toBe('https://github.com/ollama/ollama');
  });
});

describe('调研工具函数', () => {
  it('从模型回复里取 JSON', () => {
    expect(parseJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('结果 {"q":["x"]} 以上')).toEqual({ q: ['x'] });
    expect(parseJson('没有 JSON')).toBeNull();
  });
  it('抽取式要点：挑出相关句子，最相关的在前', () => {
    const text = '今天天气很好，适合出门散步。Qwen3 发布于 2025 年 4 月，提供多个尺寸。它支持思考模式和非思考模式切换。与问题无关的一句话放在这里凑数。';
    expect(extractive('Qwen3 有哪些尺寸和模式', text, 2)).toEqual(['Qwen3 发布于 2025 年 4 月，提供多个尺寸。', '它支持思考模式和非思考模式切换。']);
  });
});

/** 假网络：每个搜索词返回 3 条，其中两条同站 */
function fakeWeb() {
  const searches = [];
  const reads = [];
  return {
    searches, reads,
    search: async (q) => {
      searches.push(q);
      const k = searches.length;
      return [
        { title: `站点A-${k}-1`, url: `https://a.example/${k}/1`, snippet: `关于 ${q} 的摘要` },
        { title: `站点A-${k}-2`, url: `https://a.example/${k}/2`, snippet: 'A 站第二篇' },
        { title: `站点${k}`, url: `https://s${k}.example/`, snippet: `第 ${k} 个站点` }
      ];
    },
    read: async (url) => {
      reads.push(url);
      if (url.includes('s2.example')) throw new Error('403');
      return `${url} 的正文。本机大模型可以离线运行，数据不出电脑。Ollama 是常用的本机模型运行器，支持一键下载模型。显存越大能跑的模型越大。`.repeat(3);
    }
  };
}

describe('深度调研流程', () => {
  it('有大模型：规划 → 搜索 → 阅读 → 补查 → 带引用的报告', async () => {
    const web = fakeWeb();
    const prompts = [];
    const llm = async ({ system, prompt }) => {
      prompts.push(system);
      if (/检索计划/.test(system)) return '```json\n{"title":"本机大模型调研","outline":["现状","工具"],"queries":["本机大模型","ollama 下载"]}\n```';
      if (/摘录/.test(system)) return JSON.stringify({ relevant: true, date: '2026-01-02', points: [`要点来自 ${prompt.match(/网址：(\S+)/)[1]}`] });
      if (/是否足以/.test(system)) return '{"enough":false,"queries":["显存 要求"]}';
      return '# 标题会被去掉\n## 结论摘要\n- 可以离线运行 [1][2]，不存在的引用 [99]\n## 参考来源\n1. 模型自己写的列表会被去掉';
    };
    const progress = [];
    const r = await deepResearch({ question: '本机跑大模型需要什么', depth: 'standard', llm, search: web.search, read: web.read, onProgress: (p) => progress.push(p.stage) });
    expect(r.title).toBe('本机大模型调研');
    expect(r.queries).toEqual(['本机大模型', 'ollama 下载', '显存 要求']);
    expect(r.rounds).toBe(2);
    // 同一网站最多 2 篇；读不了的网页退回用搜索摘要
    expect(r.sources.filter((s) => s.url.includes('a.example')).length).toBe(2);
    expect(r.sources.some((s) => s.url.includes('s2.example'))).toBe(true);
    expect(new Set(r.sources.map((s) => s.url)).size).toBe(r.sources.length);
    expect(r.sources.length).toBeLessThanOrEqual(8);
    expect(r.markdown).toMatch(/^# 本机大模型调研\n/);
    expect(r.markdown).toContain('可以离线运行 [1][2]');
    expect(r.markdown).not.toContain('[99]');
    expect(r.markdown).not.toContain('模型自己写的列表');
    expect(r.markdown).toMatch(/## 参考来源\n1\. \[站点A-1-1\]\(https:\/\/a\.example\/1\/1\)/);
    expect(progress).toEqual(expect.arrayContaining(['plan', 'search', 'read', 'reflect', 'write', 'done']));
  });

  it('没有大模型（内置演示）：抽取式报告，同样带引用', async () => {
    const web = fakeWeb();
    const r = await deepResearch({ question: 'Ollama 本机模型', depth: 'quick', llm: null, search: web.search, read: web.read });
    expect(r.rounds).toBe(1);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.length).toBeLessThanOrEqual(4);
    expect(r.markdown).toContain('## 结论摘要');
    expect(r.markdown).toMatch(/Ollama 是常用的本机模型运行器.*\[1\]/);
    expect(r.markdown).toContain('内置演示模式');
  });

  it('搜索全部失败时给出明确错误；可以取消', async () => {
    await expect(deepResearch({ question: 'x', llm: null, search: async () => { throw new Error('网络错误'); }, read: async () => '' })).rejects.toThrow(/没有找到可用的资料/);
    const ac = new AbortController();
    ac.abort();
    await expect(deepResearch({ question: 'x', llm: null, signal: ac.signal, search: async () => [], read: async () => '' })).rejects.toThrow(/已取消/);
  });
});

import { nativeWebFetch, BROWSER_HEADERS } from '../src/mobile/nativeFetch.js';
import { createTools } from '../src/agent/tools.js';
import { STABLE_PROMPT } from '../src/agent/agent.js';
describe('手机上也能联网搜索', () => {
  it('原生网络读网页时带上浏览器请求头；POST（Tavily）不加', async () => {
    const seen = [];
    const f = nativeWebFetch(async (url, init) => { seen.push(init.headers); return new Response('ok'); });
    await f('https://cn.bing.com/search?q=x');
    await f('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(seen[0]['User-Agent']).toBe(BROWSER_HEADERS['User-Agent']);
    expect(seen[1]).toEqual({ 'Content-Type': 'application/json' });
  });
  it('必应结果太少时再查 DuckDuckGo，合并去重', async () => {
    const one = BING.replace(/<li class="b_algo"><h2><a href="https:\/\/example[\s\S]*?<\/li>/, '');
    const s = createSearch({ searchRegion: 'global', fetchViaGateway: async (url) => new Response(/bing/.test(url) ? one : DDG) });
    const hits = await s.search('qwen', 6);
    expect(hits.map((h) => h.url)).toEqual(['https://ollama.com/library/qwen3', 'https://github.com/ollama/ollama']);
  });
  it('web_search 一次并行搜多个词，各自给出结果或失败原因', async () => {
    const tools = Object.fromEntries(createTools({ metrics: async () => ({}), searchRegion: 'global', fetchViaGateway: async (url) => {
      if (/Malm/.test(decodeURIComponent(url))) throw new Error('网络不通');
      return new Response(/bing/.test(url) ? BING : DDG);
    } }).map((t) => [t.name, t]));
    const out = await tools.web_search.run({ queries: ['Atalanta Venezia 2026', 'Malmö FF Kalmar 2026'] });
    expect(out).toMatch(/### Atalanta Venezia 2026\n- Qwen3/);
    expect(out).toMatch(/### Malmö FF Kalmar 2026\n（搜索失败/);
  });
  it('系统提示教模型：逐个查、用原文搜、核对来源', () => {
    expect(STABLE_PROMPT).toMatch(/逐个查/);
    expect(STABLE_PROMPT).toMatch(/Atalanta/);
    expect(STABLE_PROMPT).toMatch(/核对/);
  });
});

import { parseBaidu, parseSo360, detectRegion, searchPlan } from '../src/agent/webSearch.js';
const BAIDU = `<div id="content_left">
<div class="result c-container xpath-log new-pmd" srcid="1599" id="1" tpl="se_com_default" mu="https://sports.sina.com.cn/g/seriea/2026-10-12/doc-1.shtml" data-op="{}"><div class="c-container"><h3 class="c-title t t tts-title"><a href="http://www.baidu.com/link?url=AbC" target="_blank">亚特兰大3-1威尼斯 <em>克尔斯托维奇</em>梅开二度</a></h3><div class="c-row"><span class="content-right_8Zs40">2026年10月12日 意甲第6轮，亚特兰大主场3比1击败威尼斯……</span></div></div></div>
<div mu="http://nourl.ubs.baidu.com/123" class="result c-container new-pmd" id="2"><h3 class="t"><a href="http://www.baidu.com/link?url=XyZ">竞彩赛果 周一001</a></h3><div class="c-abstract">周一001 迪拜连接 1:3 吉达国民</div></div>
<div class="result-op c-container ec_tuiguang_ad" data-tuiguang="1"><h3><a href="http://e.baidu.com/ad">推广</a></h3></div>
</div>`;
const SO = `<ul class="result">
<li class="res-list" data-lazyload="1"><h3 class="res-title "><a href="https://www.so.com/link?m=abc" rel="noopener" data-mdurl="https://www.dongqiudi.com/articles/123.html" target="_blank">考文垂4-1纽卡斯尔 - 懂球帝</a></h3><p class="res-desc">英超第6轮，考文垂主场4比1大胜纽卡斯尔。</p></li>
<li class="res-list"><h3 class="res-title"><a href="https://e.so.com/search/ad">广告</a></h3></li>
</ul>`;
describe('国内搜索源', () => {
  it('百度：取真实地址（mu），没有就用跳转链接；跳过推广', () => {
    expect(parseBaidu(BAIDU)).toEqual([
      { title: '亚特兰大3-1威尼斯 克尔斯托维奇梅开二度', url: 'https://sports.sina.com.cn/g/seriea/2026-10-12/doc-1.shtml', snippet: '意甲第6轮，亚特兰大主场3比1击败威尼斯……' },
      { title: '竞彩赛果 周一001', url: 'http://www.baidu.com/link?url=XyZ', snippet: '周一001 迪拜连接 1:3 吉达国民' }
    ]);
  });
  it('360：取 data-mdurl 真实地址，跳过广告', () => {
    expect(parseSo360(SO)).toEqual([{ title: '考文垂4-1纽卡斯尔 - 懂球帝', url: 'https://www.dongqiudi.com/articles/123.html', snippet: '英超第6轮，考文垂主场4比1大胜纽卡斯尔。' }]);
  });
  it('按网络判断地区：谷歌连不上 = 国内；连得上再看时区', async () => {
    expect(await detectRegion(async () => { throw new TypeError('blocked'); })).toBe('cn');
    expect(await detectRegion(() => new Promise(() => {}), { timeoutMs: 20 })).toBe('cn');
    expect(await detectRegion(async () => new Response(null, { status: 204 }), { timeZone: 'Europe/London' })).toBe('global');
    expect(await detectRegion(async () => new Response(null, { status: 204 }), { timeZone: 'Asia/Shanghai' })).toBe('cn');
  });
  it('国内：中文用必应中国 → 百度 → 360；英文用必应国际版；国外：必应 → DuckDuckGo', () => {
    expect(searchPlan('马尔默 卡尔马 比分', 'cn').map((x) => x[0])).toEqual(['必应中国', '百度', '360']);
    expect(searchPlan('Malmo Kalmar', 'cn')[0][1]).toMatch(/cn\.bing\.com.*ensearch=1/);
    expect(searchPlan('Malmo Kalmar', 'global').map((x) => x[0])).toEqual(['必应', 'DuckDuckGo']);
  });
  it('国内模式：必应中国被拦时用百度、360 的结果补上', async () => {
    const asked = [];
    const s = createSearch({ searchRegion: 'cn', fetchViaGateway: async (url) => { asked.push(new URL(url).host); return new Response(/baidu/.test(url) ? BAIDU : /so\.com/.test(url) ? SO : '<html>验证</html>'); } });
    const hits = await s.search('竞彩 赛果 周一', 6);
    expect(asked).toEqual(['cn.bing.com', 'cn.bing.com', 'www.baidu.com', 'www.so.com']); // 必应 RSS、必应网页、百度、360
    expect(hits.map((h) => new URL(h.url).host)).toEqual(['sports.sina.com.cn', 'www.baidu.com', 'www.dongqiudi.com']);
    expect(s.name).toMatch(/百度/);
  });
});

describe('国内用户：Tavily 和国内网站一起用', () => {
  it('中文搜索词走国内网站，外文走 Tavily；一边结果不够再补另一边', async () => {
    const asked = [];
    const s = createSearch({ tavilyKey: 'k', searchRegion: 'cn', fetchViaGateway: async (url, init) => {
      asked.push(new URL(url).host);
      if (/tavily/.test(url)) return new Response(JSON.stringify({ results: [{ title: 'ANSA', url: 'https://ansa.it/a', content: 'Atalanta 3-1', raw_content: '全文' }] }));
      return new Response(/baidu/.test(url) ? BAIDU : /so\.com/.test(url) ? SO : '<html></html>');
    } });
    expect(s.name).toMatch(/Tavily \+ 必应中国/);
    const zh = await s.search('竞彩 赛果 周一001', 6);
    expect(asked[0]).toBe('cn.bing.com');
    expect(zh.some((h) => /sina/.test(h.url))).toBe(true);
    asked.length = 0;
    const en = await s.search('Atalanta Venezia', 6, { deep: true });
    expect(asked[0]).toBe('api.tavily.com');
    expect(en[0]).toMatchObject({ url: 'https://ansa.it/a', raw: '全文' });
  });
  it('提示词：时差按事件当地时间换算，体彩“周一”是销售日', () => {
    expect(STABLE_PROMPT).toMatch(/时差/);
    expect(STABLE_PROMPT).toMatch(/销售日/);
  });
});

describe('必应 RSS 和搜不到时的原因', () => {
  const RSS = `<?xml version="1.0"?><rss><channel><title>Bing: 南京</title><item><title>南京市 - 百科</title><link>https://baike.example.com/nanjing</link><description>南京，简称“宁”，江苏省省会。</description></item><item><title>坏链接</title><link>javascript:void(0)</link></item></channel></rss>`;
  it('解析必应 RSS', () => {
    expect(parseBingRss(RSS)).toEqual([{ title: '南京市 - 百科', url: 'https://baike.example.com/nanjing', snippet: '南京，简称“宁”，江苏省省会。' }]);
    expect(bingRssUrl('南京', 'cn')).toBe('https://cn.bing.com/search?format=rss&q=%E5%8D%97%E4%BA%AC&count=10&setlang=zh-Hans');
  });
  it('RSS 有结果就不用再读网页', async () => {
    const asked = [];
    const s = createSearch({ searchRegion: 'cn', fetchViaGateway: async (url) => { asked.push(url); return new Response(RSS.replace('</channel>', RSS.match(/<item>[\s\S]*?<\/item>/)[0].replace(/nanjing/g, 'a') + RSS.match(/<item>[\s\S]*?<\/item>/)[0].replace(/nanjing/g, 'b') + RSS.match(/<item>[\s\S]*?<\/item>/)[0].replace(/nanjing/g, 'c') + '</channel>')); } });
    const hits = await s.search('南京');
    expect(asked).toHaveLength(1);
    expect(hits).toHaveLength(4);
  });
  it('都没结果时逐个说明原因（被拦 / 出错 / 连不上）', async () => {
    const s = createSearch({ searchRegion: 'cn', fetchViaGateway: async (url) => {
      if (/format=rss/.test(url)) return new Response('<rss><channel></channel></rss>');
      if (/bing/.test(url)) return new Response('<html><title>必应</title></html>');
      if (/baidu/.test(url)) return new Response('<html><title>百度安全验证</title>请完成安全验证</html>');
      throw new Error('timeout');
    } });
    const err = await s.search('南京 新闻').catch((e) => e.message);
    expect(err).toMatch(/必应 RSS：0 条/);
    expect(err).toMatch(/必应中国：0 条（HTTP 200，1KB，页面标题“必应”）/);
    expect(err).toMatch(/百度：被拦截（出现验证页“百度安全验证”）/);
    expect(err).toMatch(/360：连不上（timeout）/);
    expect(err).toMatch(/博查/);
  });
});


describe('博查搜索', () => {
  const BOCHA = { code: 200, data: { webPages: { value: [{ name: '南京新闻', url: 'https://news.example.cn/1', snippet: '短摘要', summary: '更长的摘要' }] } } };
  it('请求格式、结果解析；中文先走博查，不够再用国内网站补', async () => {
    const asked = [];
    const s = createSearch({ bochaKey: 'sk-test', searchRegion: 'cn', fetchViaGateway: async (url, init) => {
      asked.push([new URL(url).host, init]);
      return new Response(/bochaai/.test(url) ? JSON.stringify(BOCHA) : '<rss><channel></channel></rss>');
    } });
    const hits = await s.search('南京 新闻', 6, { freshness: 'week' });
    const [host, init] = asked[0];
    expect(host).toBe('api.bochaai.com');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toMatchObject({ query: '南京 新闻', summary: true, freshness: 'oneWeek' });
    expect(hits[0]).toEqual({ title: '南京新闻', url: 'https://news.example.cn/1', snippet: '更长的摘要' });
    expect(asked.length).toBeGreaterThan(1); // 只有 1 条，不够 3 条，再用免密钥补
    expect(s.name).toMatch(/^博查 \+ /);
  });
  it('博查出错（余额不足等）时用免密钥的结果，并且不会整个报错', async () => {
    const RSS = `<rss><channel>${[1, 2, 3].map((i) => `<item><title>t${i}</title><link>https://x.example/${i}</link><description>d</description></item>`).join('')}</channel></rss>`;
    const s = createSearch({ bochaKey: 'sk', searchRegion: 'cn', fetchViaGateway: async (url) => (/bochaai/.test(url) ? new Response(JSON.stringify({ code: 403, msg: '余额不足' }), { status: 403 }) : new Response(RSS)) });
    expect((await s.search('南京')).map((h) => h.title)).toEqual(['t1', 't2', 't3']);
  });
  it('都失败时报出各自的原因', async () => {
    const s = createSearch({ bochaKey: 'sk', searchRegion: 'cn', fetchViaGateway: async (url) => (/bochaai/.test(url) ? new Response(JSON.stringify({ code: 401, msg: 'Invalid API KEY' }), { status: 401 }) : new Response('')) });
    await expect(s.search('南京')).rejects.toThrow(/博查返回 401：Invalid API KEY[\s\S]*必应 RSS：0 条/);
  });
});

describe('Tavily', () => {
  it('密钥同时放请求头和请求体；出错时说清楚原因', async () => {
    const seen = [];
    const ok = createSearch({ tavilyKey: 'tvly-abc', fetchViaGateway: async (url, init) => { seen.push(init); return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://a.example', content: 'c' }] })); } });
    expect(ok.name).toMatch(/Tavily/);
    const only = searchEngines({ tavilyKey: 'tvly-abc', fetchViaGateway: async (url, init) => { seen.push(init); return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://a.example', content: 'c' }] })); } })[0];
    expect((await only.search('x'))[0].url).toBe('https://a.example');
    expect(seen[0].headers.Authorization).toBe('Bearer tvly-abc');
    expect(JSON.parse(seen[0].body).api_key).toBe('tvly-abc');
    const bad = searchEngines({ tavilyKey: 'tvly-x', fetchViaGateway: async () => new Response('{"detail":{"error":"Unauthorized: missing or invalid API key."}}', { status: 401 }) })[0];
    await expect(bad.search('x')).rejects.toThrow(/Tavily 返回 401：Key 无效或没生效.*（Unauthorized: missing or invalid API key.）/);
    const quota = searchEngines({ tavilyKey: 'tvly-x', fetchViaGateway: async () => new Response('{}', { status: 432 }) })[0];
    await expect(quota.search('x')).rejects.toThrow(/服务账户或套餐受限/);
    const down = searchEngines({ tavilyKey: 'tvly-x', fetchViaGateway: async () => { throw new TypeError('Failed to fetch'); } })[0];
    await expect(down.search('x')).rejects.toThrow(/连不上 Tavily/);
  });
});

describe('手机原生网络读网页：拿原始字节', () => {
  it('GET 读网页要 arraybuffer，Base64 正文还原成字节；POST 接口仍是文字', async () => {
    const { nativeFetcher } = await import('../src/mobile/nativeFetch.js');
    const reqs = [];
    const http = { request: async (o) => { reqs.push(o); return o.method === 'GET' ? { status: 200, data: btoa(String.fromCharCode(0xd6, 0xf7)), headers: { 'Content-Type': 'text/html; charset=gbk' } } : { status: 200, data: '{"ok":1}', headers: {} }; } };
    const f = nativeWebFetch(nativeFetcher(http));
    const res = await f('https://cp.example.cn/');
    expect(reqs[0].responseType).toBe('arraybuffer');
    expect(reqs[0].readTimeout).toBe(30000);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xd6, 0xf7]);
    await f('https://api.example.com/x', { method: 'POST', body: '{}' });
    expect(reqs[1].responseType).toBe('text');
  });
});
