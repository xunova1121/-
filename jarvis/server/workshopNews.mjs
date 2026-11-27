import { createPublicReadCache } from '../src/agent/publicReadCache.js';
import { readWorkshopHeadlines } from '../src/core/workshopNewsSource.js';
import { newsArticleUrl, readWorkshopArticle } from '../src/core/workshopNewsArticle.js';

// 全部设备共用一份标题索引和少量原文缓存；取正文仅接受新闻索引所支持的媒体文章地址。
export function createWorkshopNewsRoute(json) {
  const cache = createPublicReadCache({ maxRows: 1, maxChars: 32_000 });
  const articles = createPublicReadCache({ maxRows: 12, maxChars: 32_000 });
  return async (res, article) => {
    const url = article === undefined ? '' : newsArticleUrl(article);
    if (article !== undefined && !url) return json(res, 400, { error: '仅支持工作台新闻的来源地址' });
    const controller = new AbortController();
    const stop = () => controller.abort();
    res.once('close', stop);
    try {
      const text = await (url ? articles : cache).read(url || 'workshop-news', async signal => {
        const { publicFetch } = await import('./taskRunner.mjs');
        const options = { get: publicFetch, signal };
        return JSON.stringify(url ? await readWorkshopArticle(url, options) : await readWorkshopHeadlines(options));
      }, { signal: controller.signal, ttlMs: url ? 5 * 60_000 : 60_000 });
      if (!controller.signal.aborted) json(res, 200, JSON.parse(text));
    } catch {
      if (!controller.signal.aborted) json(res, 503, { error: url ? '暂时没取到这篇报道的正文' : '暂时没取到近 24 小时的新闻', code: 'WORKSHOP_NEWS_UNAVAILABLE' });
    } finally { res.off('close', stop); }
  };
}
