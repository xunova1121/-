import { WEATHER_HEALTH } from './weatherProvider.js';
import { createLastGood } from './lastGood.js';
import { createLookupHealth } from './health.js';
import { lookupRegion, lookupSourceRegistry } from './sources.js';
import { DOMESTIC_APPROVALS } from './domesticValidation.js';
import { readLookupSource } from './readSource.js';
import { createLookupQueue, LOOKUP_OPERATIONS } from './operations.js';
import { readLookupPreferences } from './preferences.js';

/** 评测专用内存存储；不使用全局kv后端，避免污染生产来源健康。 */
export function memoryLookupStorage() {
  const data = new Map();
  return { get: async id => data.get(id), put: async row => { data.set(row.id, row); } };
}
export function createLookupService({ storage, get, now = Date.now } = {}) {
  const health = createLookupHealth({ storage, now });
  const lastGood = createLastGood({ storage, now });
  const registry = options => lookupSourceRegistry({ ...options, approvals: DOMESTIC_APPROVALS });
  const all = () => [...new Map([
    registry({ kind: 'news' }), ...['国际', '财经', '科技'].map(category => registry({ kind: 'news', params: { categories: [category] } })),
    registry({ kind: 'sports_news' })
  ].flat().map(source => [source.id, source])).values()];
  let checking = false;
  const status = async (region = 'auto') => ({ region, resolvedRegion: lookupRegion(region),
    operations: await Promise.all([...LOOKUP_OPERATIONS, ...WEATHER_HEALTH].map(async source => ({ id: source.id, label: source.label, region: source.region, validation: source.validation, validationNote: '随真实查询更新，主动检查不猜地点/代码或请求模型', ...(await health.get(source.id)) }))),
    sources: await Promise.all(all().map(async source => ({ id: source.id, label: source.label, category: source.category,
      region: source.region, validation: source.validation, validationNote: source.validationNote || '', ...(await health.get(source.id)) }))) });
  return {
    health, registry, lastGood, status, preferences: () => readLookupPreferences(storage),
    options: (region = 'auto') => ({ region, health, registry, lastGood, now, probeUnknown: true, queue: createLookupQueue() }),
    async probe(region = 'auto', { signal } = {}) {
      lookupRegion(region);
      if (checking) throw Object.assign(new Error('正在检查来源，请稍候'), { code: 'LOOKUP_BUSY', status: 429 });
      if (signal?.aborted) throw signal.reason;
      checking = true;
      try {
        // 查询工具需要城市、证券代码或用户URL，不能为“检查来源”猜参数请求；状态随真实调用更新。
        const sources = all().filter(source => !source.tools);
        let next = 0;
        const worker = async () => {
          while (next < sources.length) {
            if (signal?.aborted) throw signal.reason;
            const source = sources[next++];
            // 主动检查每源只读列表1次，不读正文、不请求模型，也不会将待选来源自动启用。
            const row = await readLookupSource(source, { get, now: now(), signal, detailLimit: 0 });
            await health.record(source.id, row, { signal });
          }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
        return status(region);
      } finally { checking = false; }
    }
  };
}
