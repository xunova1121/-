import { it, expect } from 'vitest';
import { createLookupHealth, LOOKUP_COOLDOWN_MS } from '../src/agent/lookup/health.js';
const memory = () => {
  const values = new Map();
  return { get: async id => structuredClone(values.get(id)), put: async row => values.set(row.id, structuredClone(row)) };
};
it('同源并发写串行合并，最近10次持久化，三个连续失败冷却30分钟，到期可再选', async () => {
  let tick = 100000;
  const storage = memory();
  const health = createLookupHealth({ storage, now: () => tick });
  await Promise.all(Array.from({ length: 12 }, () => health.record('fixture', { state: 'ok', elapsedMs: 12 })));
  expect((await health.get('fixture')).samples).toHaveLength(10);
  for (let i = 0; i < 3; i++) await health.record('fixture', { state: 'failed', elapsedMs: 8000, code: 'LOOKUP_TIMEOUT' });
  const restored = createLookupHealth({ storage, now: () => tick });
  expect(await restored.get('fixture')).toMatchObject({ cooling: true, cooldownUntil: tick + LOOKUP_COOLDOWN_MS });
  tick += LOOKUP_COOLDOWN_MS;
  expect((await restored.get('fixture')).cooling).toBe(false);
  await restored.record('fixture', { state: 'ok', elapsedMs: 8 });
  expect((await restored.get('fixture')).cooldownUntil).toBe(0);
});
it('空内容不算网络失败，停止/预算不污染健康记录，隔离实例不污染生产存储', async () => {
  const health = createLookupHealth({ storage: memory() });
  for (let i = 0; i < 3; i++) await health.record('fixture', { state: 'empty' });
  expect((await health.get('fixture')).cooling).toBe(false);
  await health.record('fixture', { state: 'failed', code: 'RETRIEVAL_BUDGET' });
  const ctrl = new AbortController(); ctrl.abort(new Error('停止'));
  await expect(health.record('fixture', { state: 'ok' }, { signal: ctrl.signal })).rejects.toThrow('停止');
  expect((await health.get('fixture')).samples).toHaveLength(3);
  expect((await createLookupHealth({ storage: memory() }).get('fixture')).samples).toEqual([]);
});
it('存储故障保留有上限的内存健康，回执明确未落盘，不带网页/错误正文', async () => {
  const broken = async () => { throw new Error('disk'); };
  const health = createLookupHealth({ storage: { get: broken, put: broken } });
  await health.record('fixture', { state: 'failed', items: [{ title: '不应保存' }], reason: '敏感正文', elapsedMs: Infinity });
  const result = await health.get('fixture');
  expect(result.storageError).toContain('保存');
  expect(JSON.stringify(result)).not.toMatch(/不应保存|敏感正文/);
  expect(result.samples[0].elapsedMs).toBe(60000);
  await expect(health.get('../bad')).rejects.toThrow('来源编号');
});
