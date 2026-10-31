import { withWebDeadline } from './request.js';

/** 沿用原工具的提供者、凭据和回执；记录的是整项查询健康，不冒充单个上游可用性。 */
export const LOOKUP_OPERATIONS = [
  { id: 'query_weather', label: '天气查询（和风及原有备用）', kinds: ['weather'], tools: ['get_weather'], region: 'cn', priority: 1, timeoutMs: 8000, needsKey: false, optionalKey: true, validation: 'existing' },
  { id: 'query_sports', label: '赛程查询（直播吧及原有备用）', kinds: ['sports_live'], tools: ['get_sports_scores'], region: 'cn', priority: 1, timeoutMs: 8000, needsKey: false, validation: 'existing' },
  { id: 'query_market', label: '股票日K查询（原有同源口径）', kinds: ['market'], tools: ['get_stock_kline'], region: 'cn', priority: 1, timeoutMs: 8000, needsKey: false, validation: 'existing' },
  { id: 'query_search', label: '通用搜索（已配置引擎）', kinds: ['general', 'market'], tools: ['web_search'], region: 'cn', priority: 2, timeoutMs: 8000, needsKey: false, optionalKey: true, validation: 'existing' },
  { id: 'query_page', label: '网页读取（原安全网关）', kinds: ['general'], tools: ['fetch_url'], region: 'global', priority: 2, timeoutMs: 8000, needsKey: false, validation: 'existing' },
  { id: 'query_json', label: '公开JSON（原信任域白名单）', kinds: ['general', 'market'], tools: ['fetch_json'], region: 'cn', priority: 2, timeoutMs: 8000, needsKey: false, validation: 'existing' }
];

/** 每轮并发最多4项；排队也算同一时钟，用户停止时不再发出排队请求。 */
export function createLookupQueue(limit = 4) {
  let active = 0;
  const waiting = [];
  return async work => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { return await work(); }
    finally { active--; waiting.shift()?.(); }
  };
}

export async function runLookupOperation(tool, args, execution, lookup = {}) {
  const source = LOOKUP_OPERATIONS.find(row => row.tools.includes(tool.name));
  if (!source) return tool.run(args, execution);
  const { signal, retrieval } = execution;
  const started = performance.now();
  const work = async () => {
    if (signal?.aborted) throw signal.reason;
    const status = await lookup.health?.get(source.id);
    if (signal?.aborted) throw signal.reason;
    if (status?.cooling) throw Object.assign(new Error(`${source.label}连续连接失败，冷却至${new Date(status.cooldownUntil).toISOString()}；可换原有来源或稍后重试`), { code: 'LOOKUP_SOURCE_COOLING' });
    const timeoutMs = Math.min(source.timeoutMs, retrieval?.remaining ?? Infinity);
    if (timeoutMs <= 0) throw Object.assign(new Error('本轮查询时间已用完，未发起新请求'), { code: 'RETRIEVAL_BUDGET' });
    try {
      const result = await withWebDeadline(activeSignal => tool.run(args, { ...execution, signal: activeSignal }), { signal, timeoutMs });
      if (signal?.aborted) throw signal.reason;
      await lookup.health?.record(source.id, { state: 'ok', elapsedMs: performance.now() - started }, { signal });
      return result;
    } catch (error) {
      // 输入不合法、用户取消或次数耗尽不属于提供者故障，不能因此冷却整个查询入口。
      if (!signal?.aborted && !['AbortError', 'ValidationError'].includes(error.name) && !['RETRIEVAL_BUDGET', 'LOOKUP_SOURCE_COOLING', 'UNTRUSTED_JSON_HOST', 'INVALID_STOCK_INPUT'].includes(error.code)) {
        await lookup.health?.record(source.id, { state: 'failed', code: error.code || error.name, elapsedMs: performance.now() - started }, { signal });
      }
      throw error;
    }
  };
  return lookup.queue ? lookup.queue(work) : work();
}

export function connectLookupTools(tools, lookup) {
  if (!lookup) return tools;
  // 配置不回传给模型，不复制凭据进schema；每次调用保留原工具的参数/卡片/失败码。
  return tools.map(tool => LOOKUP_OPERATIONS.some(source => source.tools.includes(tool.name))
    ? { ...tool, run: (args, execution = {}) => runLookupOperation(tool, args, execution, lookup) }
    : tool);
}
