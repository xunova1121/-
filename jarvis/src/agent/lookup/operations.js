import { recoverLookup } from './recovery.js';
import { lookupIntent } from './intent.js';
import { recoveryText } from './recoveryData.js';
import { withWebDeadline } from './request.js';
import { WEATHER_FETCH_MS } from './weatherLimits.js';

/** 沿用原工具的提供者、凭据和回执；记录的是整项查询健康，不冒充单个上游可用性。 */
export const LOOKUP_OPERATIONS = [
  { id: 'query_weather', label: '天气查询（和风及原有备用）', kinds: ['weather'], tools: ['get_weather'], region: 'cn', priority: 1, timeoutMs: WEATHER_FETCH_MS, needsKey: false, optionalKey: true, validation: 'existing' },
  { id: 'query_sports', label: '赛程查询（直播吧及原有备用）', kinds: ['sports_live'], tools: ['get_sports_scores'], region: 'cn', priority: 1, timeoutMs: 8000, needsKey: false, validation: 'existing' },
  { id: 'query_market', label: '股票日K查询（原有同源口径）', kinds: ['market'], tools: ['get_stock_kline'], region: 'cn', priority: 1, timeoutMs: 10000, needsKey: false, validation: 'existing' },
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
  // 长文档、逐项核验和开发等继续使用原工具的请求上限，不套普通查询的8秒门槛。
  if (!source || execution.retrieval?.extensive) return tool.run(args, execution);
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
        await lookup.health?.record(source.id, { state: 'failed', code: [401, 403, 429].includes(error.status) ? 'LOOKUP_AUTH' : error.code || error.name, elapsedMs: performance.now() - started }, { signal });
      }
      throw error;
    }
  };
  return lookup.queue ? lookup.queue(work) : work();
}

const RECOVERY_TOOLS = new Set(['get_weather', 'get_sports_scores', 'get_stock_kline', 'get_today_news', 'web_search']);
export function connectLookupTools(tools, lookup) {
  if (!lookup) return tools;
  // 配置不回传给模型，不复制凭据进schema；每次调用保留原工具的参数/卡片/失败码。
  const raw = name => tools.find(tool => tool.name === name);
  return tools.map(tool => {
    const guarded = (args, execution) => runLookupOperation(tool, args, execution, lookup);
    if (!RECOVERY_TOOLS.has(tool.name)) return LOOKUP_OPERATIONS.some(source => source.tools.includes(tool.name)) ? { ...tool, run: guarded } : tool;
    return { ...tool, recoveryManaged: true, run: async (args, execution = {}) => {
      const request = execution.requestText || '';
      const intent = execution.retrieval?.intent || lookupIntent(request);
      if (!request || !intent.lookup || execution.retrieval?.extensive) return guarded(args, execution);
      const kind = { get_weather: 'weather', get_stock_kline: 'market', get_sports_scores: 'sports_live' }[tool.name] || intent.kind;
      const timeoutMs = tool.name === 'get_weather' ? WEATHER_FETCH_MS : ['get_stock_kline', 'get_today_news', 'get_sports_scores'].includes(tool.name) ? 10000 : 5000;
      const found = await recoverLookup({ ...intent, kind }, { name: tool.name, args, timeoutMs }, {
        text: request, signal: execution.signal, retrieval: execution.retrieval, lastGood: lookup.lastGood, nowFn: lookup.now,
        getTool: raw,
        execute: async (calls, signal) => Promise.all(calls.map(async call => {
          try {
            const value = await runLookupOperation(raw(call.name), call.args, { ...execution, signal }, lookup);
            return { ok: true, output: typeof value === 'object' && 'text' in value ? value.text : String(value) };
          } catch (error) {
            if (execution.signal?.aborted) throw error;
            return { ok: false, failure: { name: error.name, code: error.code, kind: error.kind, status: error.status } };
          }
        }))
      });
      if (found.recovery.state === 'failed' || found.recovery.state === 'input') throw Object.assign(new Error(found.output), { code: found.recovery.state === 'input' ? 'LOOKUP_INPUT_REQUIRED' : 'LOOKUP_RECOVERY_EXHAUSTED', name: found.recovery.state === 'input' ? 'ValidationError' : 'LookupRecoveryError', lookupRecovery: found.recovery });
      if (found.recovery.state === 'fresh') return found.output;
      return { text: recoveryText(found), lookupRecovery: { ...found.recovery, output: found.output, tool: found.tool } };
    } };
  });
}
