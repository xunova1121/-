import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkshopNewsFeed } from '../src/core/workshopNews.js';
import { CCTV_NEWS_INDEX, NEWS_REFRESH_MS, readWorkshopHeadlines, workshopHeadlines } from '../src/core/workshopNewsSource.js';
import { createServerClient } from '../src/core/serverClient.js';
import { memberRoute } from '../server/userRoutes.mjs';

const at = Date.parse('2026-11-20T18:30:00+08:00');
const cctv = 'https://news.cctv.com/2026/11/20/ARTIaaa261120.shtml';
const row = { title: '国产轻型直升机开展验证试飞', url: cctv, focus_date: '2026-11-20 18:01:55' };
const item = { title: row.title, url: row.url, source: '央视网', publishedAt: '2026-11-20T10:01:55.000Z' };
const cctvBody = list => new Response('news(' + JSON.stringify({ data: { list } }) + ')');
const data = { items: [item], updatedAt: at, stale: false };
const storage = () => { const entries = new Map(); return { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) }; };
afterEach(() => vi.unstubAllGlobals());

describe('工作台公开新闻', () => {
  it('只取当天或近24小时真实条目、去重、保留绝对北京时间并限制原文域名', async () => {
    const earlier = { ...row, url: cctv.replace('aaa', 'bbb'), focus_date: '2026-11-19 18:51:00' };
    const get = vi.fn().mockResolvedValue(cctvBody([earlier, row, row, { ...row, url: 'https://news.cctv.com.evil.example/a' }, { ...row, url: cctv.replace('aaa', 'ccc'), focus_date: '2026-11-20 18:31:00' }, { ...row, url: cctv.replace('aaa', 'ddd'), focus_date: '2026-11-19 18:20:00' }]));
    const result = await readWorkshopHeadlines({ get, now: () => at });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(item);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(CCTV_NEWS_INDEX, expect.objectContaining({ credentials: 'omit' }));
    expect(workshopHeadlines(Array.from({length: 40}, (_, i) => ({...item, url: cctv.replace('aaa', String(i))})), at)).toHaveLength(12);
  });

  it('回调包装夹带脚本时不执行，回退中新网，显示实际来源', async () => {
    const url = 'https://www.chinanews.com.cn/gn/2026/11-20/123456.shtml';
    const get = vi.fn().mockResolvedValueOnce(new Response('news({});globalThis.__badNews = true'))
      .mockResolvedValueOnce(new Response(`<li><div class="dd_lm">国内</div><a href="${url}">正式发布的一条国内新闻</a><div class="dd_time">11-20 18:22</div></li>`));
    const result = await readWorkshopHeadlines({ get, now: () => at });
    expect(result.items[0]).toMatchObject({ url, source: '中新网', publishedAt: '2026-11-20T10:22:00.000Z' });
    expect(globalThis.__badNews).toBeUndefined();
  });

  it('云端读新闻沿用登录，缓存不改刷新时间，离线再打开也能看到原来源', async () => {
    let time = at;
    const saved = storage();
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(data)).mockRejectedValue(new Error('offline'));
    const server = createServerClient({ base: 'https://studio.example', token: 'test', fetchImpl });
    const feed = createWorkshopNewsFeed({ server }, { storage: saved, now: () => time });
    expect(feed.peek()).toBeNull();
    expect(await feed.load()).toEqual(data);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://studio.example/api/workshop/news');
    expect(new Headers(opts.headers).get('authorization')).toBe('Bearer test');
    expect(await feed.load()).toEqual(data);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time += NEWS_REFRESH_MS + 1000;
    const offline = createWorkshopNewsFeed({ server }, { storage: saved, now: () => time });
    expect(offline.peek()).toEqual({ ...data, stale: true });
    expect(await offline.load()).toEqual({ ...data, stale: true });
  });

  it('本机网关和安卓本机分别使用固定只读接口及原生网络', async () => {
    const localFetch = vi.fn().mockResolvedValue(Response.json(data));
    const native = vi.fn().mockResolvedValue(cctvBody([row]));
    vi.stubGlobal('__jarvisNativeFetch', native);
    const feed = app => createWorkshopNewsFeed(app, { storage: storage(), fetchImpl: localFetch, now: () => at });
    expect(await feed({ gateway: { origin: 'http://localhost:8787' } }).load()).toEqual(data);
    expect(localFetch.mock.calls[0][0]).toBe('http://localhost:8787/api/workshop/news');
    expect(native).not.toHaveBeenCalled();
    expect(await feed({}).load()).toEqual(data);
    expect(native.mock.calls[0][0]).toBe(CCTV_NEWS_INDEX);
    expect(memberRoute('GET','/api/workshop/news')).toBe(true);
    expect(memberRoute('POST','/api/workshop/news')).toBe(false);
  });

  it('并行刷新中迟到的失败不能覆盖已经成功的新批次', async () => {
    let fail;
    const workshopNews = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce(data);
    const feed = createWorkshopNewsFeed({server:{workshopNews}}, {storage:storage(), now:() => at});
    const first = feed.load();
    await expect(feed.load()).resolves.toEqual(data);
    fail(new Error('offline'));
    await expect(first).resolves.toEqual(data);
    expect(feed.peek().stale).toBe(false);
  });

  it('取消时即使上游忽略信号，也不显示缓存成功或从备用源重试', async () => {
    const get = vi.fn(() => new Promise(() => {}));
    const ctrl = new AbortController();
    const job = readWorkshopHeadlines({ get, signal: ctrl.signal });
    await Promise.resolve();
    ctrl.abort();
    await expect(job).rejects.toMatchObject({name:'AbortError'});
    expect(get).toHaveBeenCalledTimes(1);
    const feed = createWorkshopNewsFeed({server:{workshopNews: async () => data}}, {storage:storage(), now:() => at});
    await feed.load();
    await expect(feed.load({signal:ctrl.signal})).rejects.toMatchObject({name:'AbortError'});
  });
});
