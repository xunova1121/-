import { describe, it, expect, vi } from 'vitest';
import { isOfficialSource, mergeSearchHits, officialQueries } from '../src/agent/officialSources.js';
import { createSearch } from '../src/agent/webSearch.js';
import { pageLinks, appendPageLinks, formatPageResult } from '../src/agent/pageLinks.js';
import { webBody } from '../src/agent/webBody.js';
import { sourceQueue } from '../src/agent/searchSources.js';
import { factCheck, formatReport } from '../src/agent/factCheck.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { isQuickLookup } from '../src/agent/lookupDeadline.js';

const rss = urls => '<rss><channel>' + urls.map(url => `<item><title>机构概况</title><link>${url}</link><description>职责</description></item>`).join('') + '</channel></rss>';

describe('免费搜索与官方证据', () => {
  it('合并去重、去追踪参数并优先真实政府域名，拒绝伪装域名', () => {
    const hits = mergeSearchHits(['https://news.example/a', 'https://a.gov.cn/x?utm_source=bing#top', 'https://a.gov.cn/x', 'javascript:alert(1)'].map(url => ({ url })));
    expect(hits.map(x => x.url)).toEqual(['https://a.gov.cn/x', 'https://news.example/a']);
    expect(isOfficialSource('https://gov.cn.evil.example')).toBe(false);
    expect(isOfficialSource('https://gov.cn@evil.example')).toBe(false);
    expect(isOfficialSource('https://anything.org.cn')).toBe(false);
    expect(officialQueries('江苏省供销合作社概况', hits)).toEqual(['江苏省供销合作社概况 site:gov.cn', '江苏省供销合作社概况 site:jiangsu.gov.cn', '江苏省供销合作社概况 site:a.gov.cn']);
    expect(officialQueries('机构概况 site:gov.cn', hits)).toEqual([]);
  });
  it('四条RSS也查百度，site新词在请求前扣预算，同词换源不扣', async () => {
    const calls = [], debits = [];
    const search = createSearch({ searchRegion: 'cn', fetchViaGateway: async url => {
      calls.push({ url, debits: debits.length });
      return new Response(url.includes('format=rss') ? rss(['https://news.example/1','https://news.example/2','https://news.example/3','https://news.example/4']) : '<html/>');
    } });
    await search.search('江苏机构概况', 6, { consume: kind => debits.push(kind) });
    expect(calls).toHaveLength(6);
    expect(debits).toEqual(['search', 'search']);
    expect(calls.slice(0,2).every(x => x.debits === 0)).toBe(true);
    expect(calls.slice(2,4).every(x => x.debits === 1)).toBe(true);
    expect(calls.slice(4).every(x => x.debits === 2)).toBe(true);
    const before = calls.length;
    await expect(search.search('江苏机构概况', 6, { consume: () => { throw Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' }); } })).rejects.toHaveProperty('code','RETRIEVAL_BUDGET');
    expect(calls.length - before).toBe(2);
  });
  it('网页链接可按栏目、详情到PDF继续读；30条上限且长正文不挤掉链接', () => {
    const links = pageLinks('<a href="/col/intro">机构概况</a><a href="../files/a.pdf">公开指南</a><a href="javascript:bad()">忽略</a>' + Array.from({length:50}, (_,i) => `<a href="/detail/${i}">详情${i}</a>`).join(''), 'https://a.gov.cn/col/index.html');
    expect(links).toHaveLength(30);
    expect(links.some(x => x.url === 'https://a.gov.cn/files/a.pdf')).toBe(true);
    const output = formatPageResult(appendPageLinks('正文'.repeat(10000), links));
    expect(output).toContain('https://a.gov.cn/files/a.pdf');
    expect(output.length).toBeLessThan(16000);
    expect(output).toMatch(/尚未读取/);
  });
  it('超大响应提前拒绝、停止时取消正文流', async () => {
    await expect(webBody(new Response('x', { headers: {'content-length': '99999'} }), 10)).rejects.toHaveProperty('code', 'WEB_BODY_LIMIT');
    const cancelled = vi.fn();
    const ctrl = new AbortController();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    const reading = webBody(response, 100, ctrl.signal);
    ctrl.abort(Object.assign(new Error('stop'), {name: 'AbortError'}));
    await expect(reading).rejects.toHaveProperty('name','AbortError');
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('排队可取消，取消的源绝不执行', async () => {
    const schedule = sourceQueue(1);
    let release;
    const first = schedule(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const ctrl = new AbortController(), work = vi.fn();
    const second = schedule(work, ctrl.signal);
    ctrl.abort(Object.assign(new Error('stop'), {name:'AbortError'}));
    await expect(second).rejects.toHaveProperty('name','AbortError');
    release();
    await first;
    expect(work).not.toHaveBeenCalled();
  });
  for (const variant of ['original', 'snippet', 'spoof', 'conflict', 'invented']) {
    it(`单一官方来源的证据分级：${variant}`, async () => {
      const quote = '本社负责指导全省供销合作事业发展';
      const url = variant === 'spoof' ? 'https://a.gov.cn.evil.example/intro' : 'https://a.gov.cn/intro';
      const result = await factCheck({ question:'机构职责', items:[{label:'省供销合作社'}], mode:'quick', rounds:1,
        search: async () => [{url,title:'机构职责',snippet:quote}],
        read: async () => variant === 'snippet' ? '' : quote,
        llm: async () => JSON.stringify({answer:quote,evidence:[{source:1,quote:variant === 'invented' ? '机构负责全国金融监管' : quote}],conflict:variant === 'conflict' ? '另一资料不同' : null})
      });
      expect(result.items[0].status).toBe(variant === 'original' ? 'official_original' : variant === 'invented' ? 'unverified' : 'single');
      if (variant === 'original') expect(formatReport(result)).toContain('已核实（官方原文）');
    });
  }
  it('明确查原文保留3分钟及20搜16读；普通45秒、长文8分钟不变', () => {
    let tick = 0;
    const strict = createRetrievalBudget('逐项核实并查原文', { now: () => tick });
    strict.begin();
    for(let i=0;i<20;i++) strict.consume('search');
    for(let i=0;i<16;i++) strict.consume('read');
    expect(strict.resources).toMatchObject({search:20,read:16});
    tick = 179999;
    expect(strict.reason).toBe('');
    tick++;
    expect(strict.reason).toContain('时间预算');
    expect(isQuickLookup('查原文江苏供销概况')).toBe(false);
    tick = 0;
    const normal = createRetrievalBudget('你好', {now: () => tick}); normal.begin();
    const long = createRetrievalBudget('写研究报告', {now: () => tick}); long.begin();
    tick = 45000;
    expect(normal.reason).toContain('时间预算');
    tick = 479999;
    expect(long.reason).toBe('');
  });
});
