import { describe, it, expect } from 'vitest';
import { createPageReader } from '../src/agent/pageReader.js';
import { searchPlan } from '../src/agent/webSearch.js';

const html = (body) => new Response(`<html><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const long = '比赛结束，主队 2 比 1 获胜。'.repeat(40);

function gateway(handlers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: init?.body && JSON.parse(init.body) });
    for (const [re, h] of handlers) if (re.test(url)) return h(url, init);
    throw new Error('ECONNRESET');
  };
  return { f, calls };
}

describe('读网页：直接读不到时用 Tavily 代读', () => {
  it('直接能读：不花 Tavily 额度', async () => {
    const g = gateway([[/example\.com/, () => html(long)]]);
    const read = createPageReader({ tavilyKey: 'k', fetchViaGateway: g.f });
    expect(await read('https://example.com/a')).toMatch(/2 比 1/);
    expect(g.calls.some((c) => /tavily/.test(c.url))).toBe(false);
  });

  it('被拦（403）或打不开：改用 Tavily /extract', async () => {
    const g = gateway([
      [/blocked\.com/, () => new Response('Forbidden', { status: 403 })],
      [/api\.tavily\.com\/extract/, () => new Response(JSON.stringify({ results: [{ url: 'x', raw_content: long }] }))]
    ]);
    const read = createPageReader({ tavilyKey: 'k', fetchViaGateway: g.f });
    expect(await read('https://blocked.com/a')).toMatch(/2 比 1/);
    const ex = g.calls.find((c) => /extract/.test(c.url));
    expect(ex.body).toMatchObject({ api_key: 'k', urls: ['https://blocked.com/a'], extract_depth: 'basic' });
    expect(await read('https://down.com/x')).toMatch(/2 比 1/); // 网络错误也代读
  });

  it('页面靠脚本加载、读出来几乎没字：改用 Tavily', async () => {
    const g = gateway([
      [/spa\.com/, () => html('<div id="app">加载中</div>')],
      [/extract/, () => new Response(JSON.stringify({ results: [{ raw_content: long }] }))]
    ]);
    expect(await createPageReader({ tavilyKey: 'k', fetchViaGateway: g.f })('https://spa.com/')).toMatch(/2 比 1/);
  });

  it('没有 Tavily Key：照旧报错；两边都失败时说清楚', async () => {
    const g = gateway([[/blocked/, () => new Response('', { status: 403 })], [/extract/, () => new Response('{}', { status: 432 })]]);
    await expect(createPageReader({ fetchViaGateway: g.f })('https://blocked.com/')).rejects.toThrow('HTTP 403');
    await expect(createPageReader({ tavilyKey: 'k', fetchViaGateway: g.f })('https://blocked.com/')).rejects.toThrow(/HTTP 403；Tavily 代读也失败：Tavily 返回 432/);
  });

  it('同一网页 15 分钟内只读一次', async () => {
    let t = 0;
    const g = gateway([[/example/, () => html(long)]]);
    const read = createPageReader({ fetchViaGateway: g.f, now: () => t });
    await read('https://example.com/');
    await read('https://example.com/');
    expect(g.calls.length).toBe(1);
    t = 16 * 60e3;
    await read('https://example.com/');
    expect(g.calls.length).toBe(2);
  });
});

describe('搜索时间范围', () => {
  const now = Date.UTC(2026, 9, 14);
  it('各搜索源带上自己的时间筛选参数', () => {
    const cn = searchPlan('比分', 'cn', 'week', now).map((x) => decodeURIComponent(x[1]));
    expect(cn[0]).toMatch(/filters=ex1:"ez2"/);
    expect(cn[1]).toMatch(new RegExp(`gpc=stf=${now / 1000 - 7 * 86400},${now / 1000}\\|stftype=1`));
    expect(cn[2]).toMatch(/adv_t=w/);
    expect(decodeURIComponent(searchPlan('score', 'global', 'year', now)[0][1])).toMatch(/ez5_\d+_\d+/);
    expect(searchPlan('score', 'global', 'day', now)[1][1]).toMatch(/df=d/);
  });
  it('不限时间时 URL 不变', () => {
    expect(searchPlan('比分', 'cn')[0][1]).toBe('https://cn.bing.com/search?q=%E6%AF%94%E5%88%86&count=10&setlang=zh-Hans');
  });
});
