import { weatherPlace } from '../src/agent/lookup/plan.js';
import { getWeather } from '../src/agent/weather.js';
import { createSportsScoresTool } from '../src/agent/sportsScores.js';
import { createStockKlineTool } from '../src/agent/stockKline.js';
import { createSearch } from '../src/agent/webSearch.js';
import { runLookup } from '../src/agent/lookup/runner.js';
import { connectLookupTools } from '../src/agent/lookup/operations.js';
import { createLookupClock, LOOKUP_TOTALS, createRetrievalBudget } from '../src/agent/lookup/clock.js';

/** 只读公开取数探测，沿用生产runner和原工具；不读生产配置，不伪称已测和风Key或模型耗时。 */
export async function lookupPublicQuery(text, intent, { service, signal, get = (...args) => fetch(...args) }) {
  if (intent.kind === 'general') return { state: 'requires_model', items: [], failures: [], reads: 0, searches: 0, modelRequested: false,
    note: '一般问题由模型决定是否调用web_search/fetch_url；本脚本不调用模型，不能冒充完成问答验收' };
  const clock = createLookupClock({ totalMs: LOOKUP_TOTALS[intent.kind] || 45000 });
  const retrieval = createRetrievalBudget(text, { clock });
  retrieval.intent = intent; retrieval.intentRequest = text;
  const engine = createSearch({ fetchViaGateway: get, searchRegion: 'cn' });
  const tools = connectLookupTools([
    { name: 'get_weather', run: ({ place }, execution) => getWeather(place, { ...execution, get }) },
    createSportsScoresTool({ fetchImpl: get }), createStockKlineTool({ fetchImpl: get }),
    { name: 'web_search', run: async ({ query }, execution) => {
      retrieval.consume('search');
      return JSON.stringify(await engine.search(query, 6, { ...execution, consume: kind => retrieval.consume(kind) }));
    } }
  ], service.options('cn'));
  const failures = [];
  const found = await runLookup(intent, { text, clock, signal, getTool: name => tools.find(tool => tool.name === name),
    execute: async (calls, activeSignal) => Promise.all(calls.map(async call => {
      try {
        if (!retrieval.begin()) throw Error(retrieval.note);
        const output = await tools.find(tool => tool.name === call.name).run(call.args, { signal: activeSignal, retrieval, requestText: text });
        retrieval.end(true); return { ok: true, output: String(output) };
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push({ source: call.name, reason: String(error.message).slice(0, 160) }); retrieval.end(false);
        return { ok: false, output: '' };
      }
    })) });
  return { state: found ? 'fetched' : intent.kind === 'weather' && !weatherPlace(text, intent.params) ? 'needs_location' : 'failed', items: found?.items || [],
    failures, reads: retrieval.resources.read, searches: retrieval.resources.search, modelRequested: false,
    note: '公开无Key取数，不读取生产配置；和风已配置账号、模型总完成耗时与真机效果须正式环境另验' };
}
