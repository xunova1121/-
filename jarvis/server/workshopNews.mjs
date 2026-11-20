import { createPublicReadCache } from '../src/agent/publicReadCache.js';
import { readWorkshopHeadlines } from '../src/core/workshopNewsSource.js';

// 只有这一份公共标题索引可读。共用一分钟缓存；各设备的手动刷新也不会同时打到媒体站。
export function createWorkshopNewsRoute(json) {
  const cache = createPublicReadCache({ maxRows: 1, maxChars: 32_000 });
  return async res => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    res.once('close', stop);
    try {
      const text = await cache.read('workshop-news', async signal => {
        const { publicFetch } = await import('./taskRunner.mjs');
        return JSON.stringify(await readWorkshopHeadlines({ get: publicFetch, signal }));
      }, { signal: controller.signal, ttlMs: 60_000 });
      if (!controller.signal.aborted) json(res, 200, JSON.parse(text));
    } catch {
      if (!controller.signal.aborted) json(res, 503, { error: '暂时没取到近 24 小时的新闻', code: 'WORKSHOP_NEWS_UNAVAILABLE' });
    } finally { res.off('close', stop); }
  };
}
