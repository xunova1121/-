import { collection } from '../store.js';
import { consecutiveLookupFailures, localLookupFailure, providerLookupFailure } from './healthPolicy.js';
import { sportsDiagnostics } from '../sportsRequest.js';

export const LOOKUP_COOLDOWN_MS = 30 * 60 * 1000;
const KEY = 'lookup.health.';
const sourceKey = id => {
  if (!/^[a-z][a-z0-9_-]{0,95}$/.test(id)) throw new Error('来源编号不合法');
  return KEY + id;
};

/** 只存每源最近10次状态/耗时，不存新闻正文。实例须按本机/服务器/隔离评测分别创建。 */
export function createLookupHealth({ storage = collection('kv'), now = Date.now } = {}) {
  const queues = new Map();
  const volatile = new Map();
  let storageError = '';
  async function load(id) {
    const key = sourceKey(id);
    try { return volatile.get(key) || await storage.get(key); }
    catch { storageError = '来源健康记录暂时不能读取，当前仅保留内存记录'; return volatile.get(key); }
  }
  function view(id, record) {
    const samples = Array.isArray(record?.samples) ? record.samples.slice(-10) : [];
    // 旧样本没有明确连接故障证据就不继续冷却，保留原始样本供诊断而不删记录。
    const cooldownUntil = consecutiveLookupFailures(samples) ? Number(record?.cooldownUntil) || 0 : 0;
    const lastConnectedAt = samples.reduce((at, sample) => sample.connected ? Math.max(at, sample.at) : at, 0);
    const successRate = samples.length ? samples.filter(s => s.state === 'ok').length / samples.length : null;
    const averageMs = samples.length ? Math.round(samples.reduce((n, s) => n + s.elapsedMs, 0) / samples.length) : null;
    const authorizationIssue = samples.at(-1)?.code === 'LOOKUP_AUTH';
    return { id, samples, successRate, averageMs, authorizationIssue, lastConnectedAt, cooldownUntil, cooling: cooldownUntil > now(), storageError };
  }
  return {
    async get(id) {
      await queues.get(id)?.catch(() => {});
      return view(id, await load(id));
    },
    async record(id, result, { signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      // 空内容表示网络已通，不将凌晨尚无新闻误当网络失败；停止/预算不记成来源故障。
      if (result.state === 'skipped' || localLookupFailure(result)) return;
      const previous = queues.get(id) || Promise.resolve();
      const update = previous.catch(() => {}).then(async () => {
        if (signal?.aborted) throw signal.reason;
        const old = await load(id);
        if (signal?.aborted) throw signal.reason;
        const at = now();
        const samples = [...(Array.isArray(old?.samples) ? old.samples : []), {
          at, connected: result.state !== 'failed', state: result.state,
          elapsedMs: Math.max(0, Math.min(60000, Number(result.elapsedMs) || 0)),
          // 无code的旧record({state:'failed'})调用表示调用方已判定连接失败；实际适配器提供明确分类。
          providerFailure: result.providerFailure ?? (result.state === 'failed' && (!result.code && !result.status && !result.kind || providerLookupFailure(result))),
          ...(Number.isInteger(result.status) && { status: result.status }),
          code: String([401, 402, 403, 429].includes(result.status) ? 'LOOKUP_AUTH' : result.code || '').slice(0, 60),
          // 行情/赛程仅接受固定标签与状态字段，不写URL、请求参数、错误正文或配置。
          ...(Array.isArray(result.sourceFailures) && { sourceFailures: [
            ...result.sourceFailures.filter(row => /^(?:上海金|伦敦金|东方财富外汇|参考汇率|名字查代码|腾讯行情|(?:恒生.*指数|道琼斯工业指数|纳斯达克综合指数|标普500指数|日经225指数)（(?:腾讯行情|东方财富行情)）)$/.test(row?.source) && /^[A-Za-z0-9_]{1,60}$/.test(row?.code)).slice(0, 8).map(row => ({ source: row.source, code: row.code })),
            ...sportsDiagnostics(result.sourceFailures)
          ].slice(0, 8) })
        }].slice(-10);
        const cooling = consecutiveLookupFailures(samples);
        const record = { id: sourceKey(id), samples, cooldownUntil: cooling ? at + LOOKUP_COOLDOWN_MS : 0 };
        volatile.set(record.id, record);
        // 来源集合目前不足20个；上限兜住后续动态栏目，不无限堆积内存。
        if (volatile.size > 128) volatile.delete(volatile.keys().next().value);
        try { await storage.put(record); storageError = ''; }
        catch { storageError = '来源健康记录暂时不能保存，当前仅保留内存记录'; }
        return view(id, record);
      });
      queues.set(id, update);
      try { return await update; }
      finally { if (queues.get(id) === update) queues.delete(id); }
    }
  };
}
