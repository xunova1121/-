import { describe, it, expect } from 'vitest';
import { parseBing, parseDuckDuckGo, unwrapBing, createSearch } from '../src/agent/webSearch.js';
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
    const s = createSearch({ fetchViaGateway: async (url) => { asked.push(url); return new Response(/bing/.test(url) ? '<html>验证</html>' : DDG); } });
    const hits = await s.search('ollama 本机模型');
    expect(asked[0]).toMatch(/^https:\/\/cn\.bing\.com\/search\?q=ollama/);
    expect(asked[1]).toMatch(/duckduckgo/);
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
