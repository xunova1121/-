import { it, expect } from 'vitest';
import { lookupRegion, lookupSourceRegistry, selectLookupSources } from '../src/agent/lookup/sources.js';
it('国内专题保留国内候选，实际选择仍须国内实测；每栏目健康ID独立', async () => {
  const sports = lookupSourceRegistry({ kind: 'sports_news', params: { categories: ['体育'] } });
  expect(sports.filter(s => s.region === 'cn').map(s => s.label)).toContain('中新网体育');
  expect(sports.filter(s => s.region === 'cn').map(s => s.label)).toContain('直播吧新闻');
  const selection = await selectLookupSources({ kind: 'sports_news', region: 'cn' });
  expect(selection.sources).toEqual([]);
  expect(selection.skipped.some(s => /国内网络尚未实测/.test(s.reason))).toBe(true);
  const world = lookupSourceRegistry({ kind: 'news', params: { categories: ['国际'] } });
  expect(world.some(s => s.id === 'cn_cns')).toBe(true);
  expect(world.find(s => s.family === 'bbc').id).not.toBe(sports.find(s => s.family === 'bbc').id);
});
it('地区显式覆盖优先；cn只选已连通海外补充，冷却用下一优先级；pending来源不被健康成功绕过', async () => {
  const sources = [
    { id: 'china', region: 'cn', priority: 1, validation: 'fixture' },
    { id: 'pending', region: 'cn', priority: 0, validation: 'pending_cn' },
    { id: 'world_ok', region: 'global', priority: 2, validation: 'existing' },
    { id: 'world_cold', region: 'global', priority: 3, validation: 'existing' }
  ];
  const now = 9999999;
  const health = { get: async id => ({ cooling: id === 'china', lastConnectedAt: id === 'world_cold' ? 0 : now - 100 }) };
  const cn = await selectLookupSources({ sources, health, region: 'cn', now });
  expect(cn.sources.map(s => s.id)).toEqual(['world_ok']);
  const global = await selectLookupSources({ sources, health, region: 'global', now });
  expect(global.sources.map(s => s.id)).toEqual(['world_ok', 'world_cold']);
  expect(lookupRegion('auto', 'Asia/Shanghai')).toBe('cn');
  expect(lookupRegion('auto', 'Europe/London')).toBe('global');
  expect(lookupRegion('auto', 'UTC')).toBe('cn'); // 国内云服务器常用UTC，不能据此认定海外。
  expect(lookupRegion('cn', 'Europe/London')).toBe('cn');
  expect(() => lookupRegion('invalid')).toThrow();
});
