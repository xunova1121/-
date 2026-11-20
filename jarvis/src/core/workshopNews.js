import { NEWS_REFRESH_MS, readWorkshopHeadlines, workshopHeadlines } from './workshopNewsSource.js';
import { withWebDeadline } from '../agent/lookup/request.js';

const storageKey = 'weiyang.workshop.news.v1';
const route = '/api/workshop/news';

function snapshot(data, now) {
  const updatedAt = data?.updatedAt;
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0 || updatedAt > now + 60_000) return null;
  // 离线保留上次读到的最多 12 条，只按那次的真实刷新时间判断文章时效。
  const items = workshopHeadlines(data.items, updatedAt);
  if (!items.length) return null;
  return { items, updatedAt, stale: data.stale === true || now - updatedAt >= NEWS_REFRESH_MS };
}

export function createWorkshopNewsFeed(app, { fetchImpl = (...args) => fetch(...args), now = Date.now, storage } = {}) {
  let saved;
  let revision = 0;
  try {
    storage ??= globalThis.localStorage;
    const raw = storage?.getItem(storageKey);
    if (raw && raw.length <= 32_000) saved = snapshot(JSON.parse(raw), now());
  } catch { /* 受限浏览器使用本次页面的内存缓存。 */ }

  const peek = () => snapshot(saved, now());
  async function read(signal) {
    if (app.server?.workshopNews) return app.server.workshopNews(signal);
    if (app.gateway?.origin) {
      const response = await fetchImpl(app.gateway.origin + route, { signal, credentials: 'omit' });
      if (!response.ok) throw new Error('工作台新闻暂时不可用');
      return response.json();
    }
    const native = globalThis.__jarvisNativeFetch;
    if (native) return readWorkshopHeadlines({ signal, now, get: (url, init) => native(url, { ...init, binary: true, connectTimeout: 5000, readTimeout: 5000 }) });
    // 网页首次打开时网关探测可能尚未结束。只尝试本站同一路径，独立离线页没有网关时直读公开源。
    if (/^https?:$/.test(globalThis.location?.protocol || '')) {
      const res = await fetchImpl(route, { signal, credentials: 'omit' });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) return res.json();
    }
    return readWorkshopHeadlines({ get: fetchImpl, signal, now });
  }

  return { peek, async load({ signal, force = false } = {}) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('已停止', 'AbortError');
    const cached = peek();
    const observed = revision;
    if (!force && cached && !cached.stale) return cached;
    try {
      const result = snapshot(await withWebDeadline(read, { signal, timeoutMs: 13_000 }), now());
      if (!result) throw new Error('新闻列表缺少有效的标题或发布时间');
      if (!saved || result.updatedAt >= saved.updatedAt) {
        saved = result;
        revision++;
        try { storage?.setItem(storageKey, JSON.stringify(result)); } catch { /* 配额已满时仍可在本次使用。 */ }
      }
      return peek();
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      const last = peek();
      if (last && revision !== observed) return last;
      if (last) { saved = { ...last, stale: true }; return saved; }
      throw error;
    }
  } };
}
