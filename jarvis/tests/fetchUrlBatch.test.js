import { describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createTools, normalizeArgs, validateArgs } from '../src/agent/tools.js';
import { createFetchPageRun, fetchUrlPlan, FETCH_BATCH_CHARS, FETCH_PAGE_CHARS } from '../src/agent/fetchPageTool.js';
import { pageReadBatch, pageReadSources } from '../src/agent/pageReadReceipt.js';
import { evidence } from '../src/agent/evidenceStore.js';
import { sourceCandidates } from '../src/agent/answerRequirements.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { throwControl } from '../src/core/networkRequest.js';
import { readPageCandidates } from '../src/agent/pageCandidates.js';
import { runLookupOperation } from '../src/agent/lookup/operations.js';

globalThis.indexedDB ??= new IDBFactory();
const urls = ['https://one.example.com/about', 'https://two.example.com/about', 'https://three.example.com/about'];
const body = marker => `<h1>${marker}公司介绍</h1><p>${(`${marker}公司主营农业服务，简介与业务资料。`).repeat(40)}</p>`;
const html = content => new Response(`<html><body><main>${content}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const create = get => createTools({ fetchViaGateway: get }).find(tool => tool.name === 'fetch_url');

describe('fetch_url批量参数与逐页读取', () => {
  it('仅urls单项补成url，经真实工具校验后可读取且不增加请求', async () => {
    const get = vi.fn(async () => html(body('甲'))), tool = create(get);
    const args = { urls: [urls[0]] };
    expect(validateArgs(tool, args)).toBeNull();
    expect(args).toEqual({ url: urls[0] });
    const output = await tool.run(args);
    expect(output).toContain('【网页读取回执】' + JSON.stringify({ url: urls[0] }));
    expect(output).toContain('甲公司介绍');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('参数归一化只遵循工具实际schema；旧无url字段工具契约保持，真实读取仍拒绝缺参', async () => {
    expect(validateArgs({ name: 'fetch_url', input_schema: { type: 'object', properties: {} } }, {})).toBeNull();
    const get = vi.fn(), tool = create(get);
    expect(validateArgs(tool, {})).toBeTypeOf('string');
    await expect(tool.run({})).rejects.toMatchObject({ code: 'FETCH_URL_INPUT' });
    expect(get).not.toHaveBeenCalled();
  });

  it('查询包装器同样遵循同名注入工具schema，实际run可达', async () => {
    const run = vi.fn(async () => '真实已读正文');
    const tool = { name: 'fetch_url', input_schema: { type: 'object', properties: {} }, run };
    expect(await runLookupOperation(tool, {}, {})).toBe('真实已读正文');
    expect(run).toHaveBeenCalledOnce();
  });

  it('仅urls多项保留全部阅读意图，顺序逐页计预算并存各自证据', async () => {
    const sequence = [];
    const get = vi.fn(async url => { sequence.push(url); return html(body(url === urls[0] ? '甲' : '乙')); });
    const tool = create(get), args = { urls: urls.slice(0, 2) }, sid = 'fetch-batch-independent-evidence';
    expect(validateArgs(tool, args)).toBeNull();
    expect(args).toEqual({ url: urls[0], urls: [urls[1]], read_mode: 'all' });
    const output = await tool.run(args, { sessionId: sid, retrieval: { consume: kind => sequence.push(kind) } });
    expect(sequence).toEqual(['read', urls[0], 'read', urls[1]]);
    const pages = pageReadBatch(output);
    expect(pages.map(page => [page.url, page.read])).toEqual([[urls[0], true], [urls[1], true]]);
    expect(output).toContain('甲公司介绍'); expect(output).toContain('乙公司介绍');
    for (const page of pages) expect(await evidence.get(sid, page.evidenceId)).toMatchObject({ url: page.url });
    expect((await evidence.get(sid, pages[0].evidenceId)).text).not.toContain('乙公司');
    expect(await evidence.get('another-user-session', pages[0].evidenceId)).toBeNull();
  });

  it('url+urls保留旧备选语义，胜出后取消慢页；显式all则读取全部', async () => {
    let slowSignal;
    const tool = create(async (url, { signal }) => {
      if (url === urls[0]) { slowSignal = signal; return new Promise(() => {}); }
      return html(body('乙'));
    });
    const args = { url: urls[0], urls: [urls[1]] };
    expect(validateArgs(tool, args)).toBeNull();
    expect(args.read_mode).toBeUndefined();
    const output = await tool.run(args);
    expect(pageReadBatch(output)).toBeNull();
    expect(output).toContain('【网页读取回执】' + JSON.stringify({ url: urls[1] }));
    expect(slowSignal.aborted).toBe(true);
    const get = vi.fn(async () => html(body('全部')));
    expect(pageReadBatch(await create(get).run({ ...args, read_mode: 'all' }))).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('同页片段及重复URL只读取一次，JSON数组格式仍可归一化', async () => {
    const get = vi.fn(async () => html(body('去重'))), tool = create(get);
    const args = { urls: JSON.stringify([urls[0] + '#one', urls[0] + '#two']) };
    normalizeArgs(tool, args);
    expect(args.read_mode).toBe('all');
    const output = await tool.run(args);
    expect(pageReadBatch(output)).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    { urls: [] }, { url: urls[0], urls: 'https://two.example.com' }, { urls: [urls[0], null] },
    { urls: [urls[0], 1] }, { url: urls[0], urls: ['not a URL'] }, { url: urls[0], read_mode: 'random' },
    { urls: [...urls, 'https://four.example.com/'] }, { url: urls[0], urls },
    { url: 'https://example.com/' + '中'.repeat(500) }, { url: 'file:///tmp/file' }
  ])('非法数组/类型/数量/地址在请求前拒绝：%j', async args => {
    const get = vi.fn(), tool = create(get);
    expect(validateArgs(tool, args)).toBeTypeOf('string');
    await expect(tool.run(args)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1/a', 'https://10.0.0.1/a', 'https://user:password@example.com/a', 'https://secret.internal/a'])('第三页%s被拦时前两页也不启动', async address => {
    const get = vi.fn();
    await expect(create(get).run({ urls: [urls[0], urls[1], address] })).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED' });
    expect(get).not.toHaveBeenCalled();
  });

  it('部分页面失败明确保留失败项，不追加搜索请求，也不将失败页登记为已读', async () => {
    const get = vi.fn(async url => url === urls[0] ? new Response('', { status: 404 }) : html(body('乙')));
    const args = { urls: urls.slice(0, 2) }, output = await create(get).run(args);
    const pages = pageReadBatch(output);
    expect(pages[0]).toMatchObject({ url: urls[0], read: false });
    expect(pages[1]).toMatchObject({ url: urls[1], read: true });
    expect(get.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 2));
    expect(sourceCandidates('查具体链接', 'fetch_url', output, args)).toEqual([urls[1]]);
    const delivery = createLookupDelivery('查询公司简介');
    delivery.record({ name: 'fetch_url', args, ok: true, output });
    expect(delivery.text()).toContain(urls[1]);
    expect(delivery.text()).not.toContain(urls[0]);
  });

  it('不同来源摘要分别归属实际页面，不把二页内容写到一页URL下', async () => {
    const args = { urls: urls.slice(0, 2) };
    const output = await create(async url => html(body(url === urls[0] ? '甲' : '乙'))).run(args);
    const delivery = createLookupDelivery('查询公司简介');
    delivery.record({ name: 'fetch_url', args, ok: true, output });
    const text = delivery.text();
    expect(text).toMatch(/甲公司介绍[\s\S]*https:\/\/one\.example\.com\/about[\s\S]*乙公司介绍[\s\S]*https:\/\/two\.example\.com\/about/);
    expect(sourceCandidates('查具体链接', 'fetch_url', output, args)).toEqual(urls.slice(0, 2));
  });

  it('旧单页失败后仅取得聚合线索，不能算原文已读或成功资料回执', async () => {
    const get = vi.fn(async address => address === urls[0]
      ? new Response('', { status: 404 })
      : html(`<li class="res-list"><h3><a href="${urls[1]}">乙公司搜索线索</a></h3><p class="res-desc">${'这只是搜索摘要，未读取原文。'.repeat(10)}</p></li>`));
    const args = { url: urls[0] }, output = await create(get).run(args);
    expect(output).toMatch(/^原网页读取失败/);
    expect(output).toContain('乙公司搜索线索');
    expect(pageReadSources(output)).toEqual([]);
    expect(sourceCandidates('查具体链接', 'fetch_url', output, args)).toEqual([]);
    const delivery = createLookupDelivery('查询公司简介');
    delivery.record({ name: 'fetch_url', args, ok: true, output });
    expect(delivery.hasResults).toBe(false);
    expect(delivery.text()).not.toContain('已读取该来源');
    const review = createExecutionReview('查询公司简介');
    expect(review.record({ name: 'fetch_url', args, ok: true, output }).dataRetrieved).toBe(false);
    expect(review.report().retrievalReceipts).toBe(0);
  });

  it('A主页面失败而B备选成功，摘要与新闻已读均归真实B回执，不误记A', async () => {
    const get = vi.fn(async address => address === urls[0] ? new Response('', { status: 404 }) : html(body('乙新闻')));
    const args = { url: urls[0], urls: [urls[1]] }, output = await create(get).run(args);
    expect(pageReadSources(output).map(page => page.url)).toEqual([urls[1]]);
    expect(sourceCandidates('查具体链接', 'fetch_url', output, args)).toEqual([urls[1]]);
    const delivery = createLookupDelivery('查询公司简介');
    delivery.record({ name: 'fetch_url', args, ok: true, output });
    expect(delivery.text()).toContain(urls[1]);
    expect(delivery.text()).not.toContain(urls[0]);
    const review = createExecutionReview('今日新闻，打开原文核实');
    review.record({ name: 'get_today_news', ok: true, output: JSON.stringify({ kind: 'today_news', items: urls.slice(0, 2).map(url => ({ url })) }) });
    review.record({ name: 'fetch_url', args, ok: true, output });
    review.checkAnswer('乙报道 ' + urls[1]);
    expect(review.report().sourceIssue).toBe('');
    review.checkAnswer('甲报道 ' + urls[0]);
    expect(review.report().sourceIssue).toContain('只取得汇总页');
  });

  it('单页实际渠道在摘要350字之后仍扫描正文，保留政府指南来源验收', () => {
    const url = 'https://www.nanjing.gov.cn/guide.html';
    const output = '【网页读取回执】' + JSON.stringify({ url }) + '\n政府信息公开指南\n' + '概述与申请须知。'.repeat(100) + '\n可通过网上申请、邮寄申请提交材料。';
    expect(pageReadSources(output)[0].summary).not.toContain('网上申请');
    expect(sourceCandidates('查询政府信息公开申请渠道', 'fetch_url', output, { url: urls[0] })).toEqual([url]);
  });

  it.each([
    ' \n原网页读取失败：仅有搜索线索',
    '【网页读取回执】not-json\n' + '不能作为正文'.repeat(20),
    '【网页读取回执】{"url":"https://other.example/a","read":false}\n' + '读取失败'.repeat(20),
    '【网页读取回执】{"url":"https://other.example/a"}\n',
    '【网页读取回执】{"url":"file:///etc/passwd"}\n' + '不能作为正文'.repeat(20)
  ])('失败、无正文或损坏单页回执不降级到入参冒认已读：%s', output => {
    const args = { url: urls[0] }, review = createExecutionReview('查询公司简介'), delivery = createLookupDelivery('查询公司简介');
    expect(pageReadSources(output)).toEqual([]);
    expect(review.record({ name: 'fetch_url', args, ok: true, output }).dataRetrieved).toBe(false);
    expect(review.report().retrievalReceipts).toBe(0);
    delivery.record({ name: 'fetch_url', args, ok: true, output });
    expect(delivery.hasResults).toBe(false);
    expect(sourceCandidates('查具体链接', 'fetch_url', output, args)).toEqual([]);
  });

  it('所有页面失败抛出失败，不返回伪成功正文或额外免费搜索', async () => {
    const get = vi.fn(async () => new Response('', { status: 404 }));
    await expect(create(get).run({ urls: urls.slice(0, 2) })).rejects.toMatchObject({ code: 'FETCH_PAGES_FAILED' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each(['RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED'])('%s中断后不发下一页/付费代读，之前证据仍可取', async code => {
    const error = Object.assign(new Error('停止额度'), { code });
    const get = vi.fn(async url => { if (url === urls[1]) throw error; return html(body('已取得')); });
    const tool = createTools({ fetchViaGateway: get, tavilyKey: 'fake-tavily' }).find(tool => tool.name === 'fetch_url');
    const sid = 'fetch-batch-stop-' + code;
    await expect(tool.run({ urls }, { sessionId: sid })).rejects.toMatchObject({ code });
    expect(get.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 2));
    const stored = await evidence.index(sid);
    expect(stored.map(item => item.url)).toEqual([urls[0]]);
  });

  it('每页发请求前扣读预算，预算不够时不请求第二页', async () => {
    const get = vi.fn(async () => html(body('已取得')));
    let count = 0;
    await expect(create(get).run({ urls }, { retrieval: { consume: () => { if (++count > 1) throw Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' }); } } })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(get.mock.calls.map(([url]) => url)).toEqual([urls[0]]);
  });

  it('用户停止卡住的第一页后立即结束，不发后续页面', async () => {
    const ctrl = new AbortController(), get = vi.fn(() => new Promise(() => {}));
    const pending = create(get).run({ urls }, { signal: ctrl.signal });
    await Promise.resolve(); ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(get.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('政府导航继续读取同站指南，每页证据编号与实际指南URL一致', async () => {
    const home = 'https://www.example.gov.cn/home', guide = 'https://www.example.gov.cn/guide';
    const get = vi.fn(async url => url === home ? html('<a href="/guide">信息公开申请指南</a>') : url === guide ? html('网上申请：请填写申请表；邮寄申请：寄送受理办公室。') : html(body('普通企业')));
    const args = { urls: [home, urls[0]] }, sid = 'fetch-batch-government-guide';
    const output = await create(get).run(args, { requestText: '查询政府信息公开申请渠道', sessionId: sid });
    const pages = pageReadBatch(output);
    expect(pages[0]).toMatchObject({ url: guide, requestedUrl: home, read: true });
    expect((await evidence.get(sid, pages[0].evidenceId)).url).toBe(guide);
    expect(output).toContain('最初页面（不作为指南正文证据）');
    expect(sourceCandidates('查询政府信息公开申请渠道', 'fetch_url', output, args)).toEqual([guide]);
  });

  it('长正文显示和总回执有界，保留各页证据编号、截断标记及栏目链接', async () => {
    const sid = 'fetch-batch-long-body';
    const output = await create(async () => html('正文内容'.repeat(15000) + '<a href="https://company.example.com/attachment.pdf">附件下载</a>')).run({ urls }, { sessionId: sid });
    expect(output.length).toBeLessThanOrEqual(FETCH_BATCH_CHARS);
    expect(output).toContain('本页显示片段已截断');
    expect(output).toContain('页面内链接（链接指向的内容尚未读取）');
    expect(pageReadBatch(output)).toHaveLength(3);
    for (const page of pageReadBatch(output)) expect((await evidence.get(sid, page.evidenceId)).text.length).toBeLessThanOrEqual(6000);
    for (const block of output.split(/【第 \d\/\d 页：已读取正文】\n/).slice(1)) expect(block.length).toBeLessThanOrEqual(FETCH_PAGE_CHARS + 100);
  });

  it('三个超长链接也保留所有实际来源和状态，不突破8k总上限', async () => {
    const addresses = urls.map(url => url + '?ref=' + 'x'.repeat(1950));
    const output = await create(async () => html(body('长链接') + '内容'.repeat(5000))).run({ urls: addresses });
    expect(output.length).toBeLessThanOrEqual(8000);
    expect(pageReadBatch(output).map(page => page.url)).toEqual(addresses);
    expect(pageReadBatch(output).every(page => page.read)).toBe(true);
  });

  it.each(['\\', '"'])('三页查询串含大量%s时先按编码后长度拒绝，零请求且不截断网址', async character => {
    const addresses = [1, 2, 3].map(index => `https://page${index}.example/?q=` + character.repeat(2000));
    const get = vi.fn(), tool = create(get);
    await expect(tool.run({ urls: addresses })).rejects.toMatchObject({ code: 'FETCH_URL_INPUT' });
    expect(get).not.toHaveBeenCalled();
  });

  it('短反斜杠及引号查询值无损编码，实际请求和回执一致且三页总量不突破8k', async () => {
    const addresses = [1, 2, 3].map(index => `https://page${index}.example/?q=` + '\\"'.repeat(100));
    const get = vi.fn(async () => html(body('编码查询')));
    const output = await create(get).run({ urls: addresses });
    const expected = fetchUrlPlan({ urls: addresses }).urls;
    expect(pageReadBatch(output).map(page => page.url)).toEqual(expected);
    expect(get.mock.calls.map(([url]) => url)).toEqual(expected);
    for (const address of expected) expect(new URL(address).searchParams.get('q')).toBe('\\"'.repeat(100));
    expect(output.length).toBeLessThanOrEqual(8000);
  });

  it('网址上限与证据库2000字符一致，边界原文回读不丢URL后缀', async () => {
    const prefix = 'https://source.example/?q=';
    const address = prefix + 'x'.repeat(2000 - prefix.length);
    const sid = 'fetch-batch-url-evidence-boundary', get = vi.fn(async () => html(body('网址边界')));
    const tool = create(get);
    const output = await tool.run({ urls: [address], read_mode: 'all' }, { sessionId: sid });
    const [page] = pageReadBatch(output);
    expect(page.url).toBe(address);
    expect((await evidence.get(sid, page.evidenceId)).url).toBe(address);
    await expect(tool.run({ urls: [address + 'x'] })).rejects.toMatchObject({ code: 'FETCH_URL_INPUT' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(['\u0001', '\ud800', '\\', '"'])('最长地址与两页含转义字符%s失败并存，所有回执保留且总量仍小于8k', async character => {
    const addresses = [1, 2, 3].map(index => { const prefix = `https://page${index}.example/?q=`; return prefix + 'x'.repeat(2000 - prefix.length); });
    let calls = 0;
    const output = await createFetchPageRun({}, async () => {
      if (calls++ < 2) throw Object.assign(new Error(character.repeat(300)), { code: character.repeat(80) });
      return '实际原文内容'.repeat(2000);
    })({ urls: addresses });
    expect(output.length).toBeLessThanOrEqual(FETCH_BATCH_CHARS);
    expect(pageReadBatch(output).map(page => ({ url: page.url, read: page.read }))).toEqual(addresses.map((url, index) => ({ url, read: index === 2 })));
  });

  it('多页截断只保留完整栏目链接，不产生半截网址让模型反复尝试', async () => {
    const longLink = 'https://company.example.com/details?ref=' + 'x'.repeat(900);
    const output = await create(async () => html('正文'.repeat(6000) + `<a href="${longLink}">长链接</a><a href="https://company.example.com/short">短链接</a>`)).run({ urls: urls.slice(0, 2) });
    expect(output).not.toContain('details?ref=');
    expect(output).toContain('https://company.example.com/short');
    expect(output.length).toBeLessThanOrEqual(FETCH_BATCH_CHARS);
  });

  it.each(['EVAL_QUOTA', 'EVAL_EXPIRED'])('备选与政府指引共用%s控制码，不能吞掉继续请求', async code => {
    const error = Object.assign(new Error('额度终止'), { code });
    expect(() => throwControl(error)).toThrow(error);
    await expect(readPageCandidates(urls, { read: async () => { throw error; } })).rejects.toBe(error);
  });

  it('多页已读新闻分别登记，失败的第一页不会被误标已读', async () => {
    const review = createExecutionReview('今天新闻');
    review.record({ name: 'get_today_news', ok: true, output: JSON.stringify({ kind: 'today_news', items: urls.slice(0, 2).map(url => ({ url, title: '新闻' })) }) });
    const output = await create(async url => url === urls[0] ? new Response('', { status: 404 }) : html(body('乙新闻'))).run({ urls: urls.slice(0, 2) });
    const receipt = review.record({ name: 'fetch_url', ok: true, args: { url: urls[0] }, output });
    expect(receipt.dataRetrieved).toBe(true);
  });

  it('明确fallback模式仍可仅传urls，不改变用户选择；非法类型不自动截断成字符串', () => {
    const args = { urls: urls.slice(0, 2), read_mode: 'fallback' };
    expect(fetchUrlPlan(args)).toEqual({ mode: 'fallback', urls: urls.slice(0, 2) });
  });

  it('真实lookup包装器为all逐页最多24秒，第三页能在18秒读完，不再被8秒提前切断', async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 6000)); return html(body('逐页完成')); });
      const tool = createTools({ fetchViaGateway: get, lookup: {} }).find(tool => tool.name === 'fetch_url');
      let completed = false;
      const pending = tool.run({ urls }, { retrieval: { remaining: 30000, consume: vi.fn() } }).then(value => { completed = true; return value; });
      await vi.advanceTimersByTimeAsync(8001);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(10000);
      expect(pageReadBatch(await pending)).toHaveLength(3);
      expect(get).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('多页包装器受本轮剩余9秒限制，停止后不启动第三页', async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 6000)); return html(body('逐页完成')); });
      const tool = createTools({ fetchViaGateway: get, lookup: {} }).find(tool => tool.name === 'fetch_url');
      const assertion = expect(tool.run({ urls }, { retrieval: { remaining: 9000, consume: vi.fn() } })).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(9001); await assertion;
      await vi.advanceTimersByTimeAsync(20000);
      expect(get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('用户取消多页包装器时立即结束，第三页不会发出', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      const get = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 6000)); return html(body('逐页完成')); });
      const tool = createTools({ fetchViaGateway: get, lookup: {} }).find(tool => tool.name === 'fetch_url');
      const assertion = expect(tool.run({ urls }, { signal: ctrl.signal, retrieval: { remaining: 30000, consume: vi.fn() } })).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(7000); ctrl.abort(); await assertion;
      await vi.advanceTimersByTimeAsync(20000);
      expect(get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
