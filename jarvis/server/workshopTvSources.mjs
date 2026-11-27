import { currentUser } from './userScope.mjs';
import { WORKSHOP_TV_CHANNELS } from '../shared/workshopTv.js';
import { workshopPublicChannels } from '../shared/workshopPublicTv.js';
import { parseWorkshopVideoSource } from '../shared/workshopVideoSource.js';

export const MAX_WORKSHOP_SOURCES = 50;
const BUILTIN_IDS = new Set([...workshopPublicChannels, ...WORKSHOP_TV_CHANNELS].map(ch => ch.id));
const CUSTOM_ID = /^custom-[a-z0-9-]{1,72}$/;
const compactName = text => String(text || '').replace(/[\s-]/gu, '').toLowerCase();

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status, code: 'WORKSHOP_TV_SOURCE' });
}

function validateEntry(raw) {
  if (!raw || typeof raw !== 'object' || !CUSTOM_ID.test(raw.id || '')) {
    throw badRequest('频道编号格式无效。');
  }
  const title = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!title || [...title].length > 40 || /[\r\n\t]/u.test(title)) {
    throw badRequest('请输入 1 到 40 个字的频道名称。');
  }
  const parsed = parseWorkshopVideoSource(raw.url, raw.format || 'auto');
  return { id: raw.id, name: title, url: parsed.url, format: parsed.format };
}

function sanitizeStoredSources(list) {
  if (!Array.isArray(list)) return [];
  const valid = [];
  const seen = new Set();
  for (const item of list) {
    try {
      const normalized = validateEntry(item);
      if (!seen.has(normalized.id) && valid.length < MAX_WORKSHOP_SOURCES) {
        seen.add(normalized.id);
        valid.push(normalized);
      }
    } catch { /* 跳过已损坏记录，保留其余可用频道。 */ }
  }
  return valid.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function sanitizeHidden(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const id of list) {
    if (typeof id === 'string' && BUILTIN_IDS.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function uniqueTitle(title, sources, currentId) {
  const taken = candidate => sources.some(item => item.id !== currentId && compactName(item.name) === compactName(candidate));
  if (!taken(title)) return title;
  const chars = [...title];
  for (let i = 2; i <= MAX_WORKSHOP_SOURCES + 2; i++) {
    const suffix = `（${i}）`;
    const candidate = chars.slice(0, Math.max(1, 40 - [...suffix].length)).join('') + suffix;
    if (!taken(candidate)) return candidate;
  }
  return title;
}

/** 按当前鉴权用户隔离保存小窝电视自定义源（最多50条）与已隐藏默认台。 */
export function createWorkshopTvSourcesRoutes({ store, readJson, json }) {
  // 按用户串行写盘；空闲时立即回收键，最多排16个并发请求。
  const queues = new Map();
  const pending = new Map();
  function serial(work) {
    const user = currentUser();
    const count = pending.get(user) || 0;
    if (count >= 16) throw badRequest('频道同步繁忙，请稍后再试。', 429);
    pending.set(user, count + 1);
    const next = (queues.get(user) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(user, next);
    return next.finally(() => {
      const left = (pending.get(user) || 1) - 1;
      if (left <= 0) { pending.delete(user); if (queues.get(user) === next) queues.delete(user); }
      else pending.set(user, left);
    });
  }

  return async (req, res, pathname) => {
    if (pathname !== '/api/server/workshop-tv-sources' && pathname !== '/api/server/workshop-tv-sources/sync') return false;
    try {
      if (pathname === '/api/server/workshop-tv-sources') {
        if (req.method !== 'GET') { json(res, 405, { error: '此接口仅支持 GET' }); return true; }
        const doc = await store.get('workshop_tv', 'catalog');
        json(res, 200, {
          sources: sanitizeStoredSources(doc?.sources),
          hidden: sanitizeHidden(doc?.hidden),
          initialized: Boolean(doc?.initialized),
          merged: {}
        });
        return true;
      }
      if (req.method !== 'POST') { json(res, 405, { error: '此接口仅支持 POST' }); return true; }
      const body = await readJson(req, 262144);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('同步内容格式无效。');
      const rawUpsert = body.upsert ?? [];
      const rawRemove = body.remove ?? [];
      if (!Array.isArray(rawUpsert) || rawUpsert.length > MAX_WORKSHOP_SOURCES) {
        throw badRequest(`自定义频道最多保存 ${MAX_WORKSHOP_SOURCES} 个，请先移除不用的视频源。`);
      }
      if (!Array.isArray(rawRemove) || rawRemove.length > MAX_WORKSHOP_SOURCES * 2) {
        throw badRequest('移除列表超出上限。');
      }
      if (Object.hasOwn(body, 'hidden') && !Array.isArray(body.hidden)) throw badRequest('默认频道设置格式无效。');
      if (Object.hasOwn(body, 'initHidden') && !Array.isArray(body.initHidden)) throw badRequest('默认频道设置格式无效。');
      const entries = rawUpsert.map(item => {
        try { return validateEntry(item); }
        catch (err) { throw err.code === 'WORKSHOP_TV_SOURCE' ? err : badRequest(err.message || '视频源无效。'); }
      });

      const payload = await serial(async () => {
        const doc = await store.get('workshop_tv', 'catalog');
        let sources = sanitizeStoredSources(doc?.sources);
        let hidden = sanitizeHidden(doc?.hidden);
        let initialized = Boolean(doc?.initialized);
        const merged = {};
        const removeIds = rawRemove.filter(id => typeof id === 'string' && CUSTOM_ID.test(id));
        if (removeIds.length) {
          const removeSet = new Set(removeIds);
          sources = sources.filter(item => !removeSet.has(item.id));
          initialized = true;
        }
        for (const entry of entries) {
          const idx = sources.findIndex(item => item.id === entry.id);
          const same = sources.find(item => item.id !== entry.id && item.url === entry.url && compactName(item.name) === compactName(entry.name));
          if (same) {
            if (idx >= 0) sources.splice(idx, 1);
            merged[entry.id] = same.id;
          } else if (idx >= 0) {
            sources[idx] = { ...entry, name: uniqueTitle(entry.name, sources, entry.id) };
          } else {
            if (sources.length >= MAX_WORKSHOP_SOURCES) {
              throw badRequest(`自定义频道最多保存 ${MAX_WORKSHOP_SOURCES} 个，请先移除不用的视频源。`);
            }
            sources.push({ ...entry, name: uniqueTitle(entry.name, sources, entry.id) });
          }
          initialized = true;
        }
        if (Object.hasOwn(body, 'hidden')) {
          hidden = sanitizeHidden(body.hidden);
          initialized = true;
        } else if (!initialized && Array.isArray(body.initHidden) && body.initHidden.length) {
          hidden = sanitizeHidden(body.initHidden);
          initialized = true;
        }
        sources.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        await store.put('workshop_tv', { id: 'catalog', sources, hidden, initialized });
        return { sources, hidden, initialized, merged };
      });
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 400, { error: error.message || '频道同步失败', code: error.code || 'WORKSHOP_TV_SOURCE' });
    }
    return true;
  };
}
