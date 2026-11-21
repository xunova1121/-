import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkshopNewsFeed } from '../src/core/workshopNews.js';
import { newsArticleUrl, parseWorkshopArticle, readWorkshopArticle } from '../src/core/workshopNewsArticle.js';
import { readWorkshopHeadlines } from '../src/core/workshopNewsSource.js';
import { memberRoute } from '../server/userRoutes.mjs';
import { createWorkshopNewsRoute } from '../server/workshopNews.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { createWorkshopNewsReader } from '../src/ui/workshopNewsReader.js';

const url = 'https://news.cctv.com/2026/11/20/ARTItest261120.shtml';
const cns = 'https://www.chinanews.com.cn/sh/2026/11-20/10735405.shtml';
const item = { url, source: '央视网' };
const answer = { url, paragraphs: ['原报道第一段。', '第二段。'], truncated: false };
afterEach(() => vi.unstubAllGlobals());

describe('工作台内读报道', () => {
  it('区分索引导语、正文和视频占位，不执行央视新版正文模板脚本', async () => {
    const now = Date.parse('2026-11-20T18:30:00+08:00');
    const list = [{ title: '报道标题', url, brief: '来源的实际导语。', focus_date: '2026-11-20 18:10:22' }];
    const feed = await readWorkshopHeadlines({ get: async () => new Response('news(' + JSON.stringify({ data: { list } }) + ')'), now: () => now });
    expect(feed.items[0].summary).toBe('来源的实际导语。');
    const markup = `<script>
var contentdate = '<p>[!--begin:htmlVideoCode--]ID[!--end:htmlVideoCode--]</p><p>原报道第一段。</p><p>第二段。</p>'
</script><div id="content_area"></div><p>页尾推荐不属于本文。</p>`;
    const get = vi.fn().mockResolvedValue(new Response(markup, { headers: { 'Content-Type': 'text/html;charset=utf-8' } }));
    expect(await readWorkshopArticle(url, { get })).toEqual(answer);
    expect(get).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    expect(() => parseWorkshopArticle('<meta name="description" content="只有摘要"><p>推荐新闻。</p>', url)).toThrow('正文');
  });

  it('取中新网嵌套正文容器，跳过脚本、推荐和广告；超长文标记节选', () => {
    const html = '<div class="left_zw"><div><p>首段 &amp; 出处。</p></div><style>.ad{color:red}</style><p>次段<table><tr><td>广告</td></tr></table>。</p></div><p>推荐阅读</p>';
    expect(parseWorkshopArticle(html,cns).paragraphs).toEqual(['首段 & 出处。','次段。']);
    const long = '<div id="content_area"><p>' + '字'.repeat(16_001) + '</p></div>';
    const result = parseWorkshopArticle(long,url);
    expect(result.truncated).toBe(true);
    expect(result.paragraphs[0]).toHaveLength(16_000);
  });

  it('无效地址在向媒体发请求前拒绝，并沿用成员只读鉴权', async () => {
    const get = vi.fn(), json = vi.fn();
    for (const invalid of ['http://127.0.0.1/', 'https://news.cctv.com.evil.test/2026/11/20/ARTI.shtml', 'https://news.cctv.com/api/private', 'javascript:foo']) {
      expect(newsArticleUrl(invalid)).toBe('');
      await expect(readWorkshopArticle(invalid, { get })).rejects.toThrow('来源');
      await createWorkshopNewsRoute(json)({}, invalid);
      expect(json).toHaveBeenLastCalledWith({}, 400, expect.anything());
    }
    expect(get).not.toHaveBeenCalled();
    expect(memberRoute('GET', '/api/workshop/news/article')).toBe(true);
    expect(memberRoute('POST', '/api/workshop/news/article')).toBe(false);
    expect(newsArticleUrl(url + '?tracking=1')).toBe(url);
  });

  it('云端带当前登录令牌，只接受选中报道的结果，再点已读文章可以离线阅读', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ ...answer, url: cns })).mockResolvedValueOnce(Response.json(answer));
    const server = createServerClient({ base: 'https://studio.example', token: 'test', fetchImpl });
    const feed = createWorkshopNewsFeed({ server });
    await expect(feed.readArticle(item)).rejects.toThrow('这篇报道');
    expect(await feed.readArticle(item)).toEqual(answer);
    expect(await feed.readArticle(item)).toEqual(answer);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [address, init] = fetchImpl.mock.calls[1];
    expect(address).toBe('https://studio.example/api/workshop/news/article?url=' + encodeURIComponent(url));
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test');
  });

  it('安卓实际来源使用原生网络，取消后迟到的结果不进入离线缓存', async () => {
    let resolve;
    const native = vi.fn(() => new Promise(done => { resolve = done; }));
    vi.stubGlobal('__jarvisNativeFetch', native);
    const ctrl = new AbortController();
    const feed = createWorkshopNewsFeed({});
    const pending = feed.readArticle(item, { signal: ctrl.signal });
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    ctrl.abort();
    await expect(pending).rejects.toHaveProperty('name','AbortError');
    const page = () => new Response('<div id="content_area"><p>恢复后重新读取。</p></div>', { headers:{ 'Content-Type':'text/html' } });
    resolve(page());
    native.mockResolvedValueOnce(page());
    expect((await feed.readArticle(item)).paragraphs).toEqual(['恢复后重新读取。']);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('在房间内重试、翻篇和收起，不将迟到的前篇正文写回蒙层', async () => {
    const content = { setAttribute: vi.fn(), replaceChildren: vi.fn() };
    vi.stubGlobal('document', { createElement: tag => tag === 'div' ? content : {} });
    const ui = { original: { setAttribute: vi.fn(), removeAttribute: vi.fn() }, news: { append: vi.fn() },
      digest: {}, headlines: { replaceChildren: vi.fn() }, scroll: { scrollTop: 120 } };
    let finish;
    const readArticle = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ paragraphs: ['新文章正文'] });
    const select = createWorkshopNewsReader(ui, { readArticle });
    const event = { preventDefault: vi.fn() };
    select(item);
    expect(ui.scroll.scrollTop).toBe(0);
    const pending = ui.original.onclick(event);
    const signal = readArticle.mock.calls[0][1].signal;
    select({ url: cns, source: '中新网', summary: '新文章导语' });
    expect(signal.aborted).toBe(true);
    finish(answer);
    await pending;
    expect(content.textContent).toContain('新文章导语');
    expect(content.replaceChildren).not.toHaveBeenCalled();
    await ui.original.onclick(event);
    expect(ui.original.textContent).toBe('重试阅读');
    await ui.original.onclick(event);
    expect(content.replaceChildren).toHaveBeenCalledWith({ textContent: '新文章正文' });
    await ui.original.onclick(event);
    expect(ui.original.textContent).toBe('阅读原文');
    expect(event.preventDefault).toHaveBeenCalledTimes(4);
  });
});
