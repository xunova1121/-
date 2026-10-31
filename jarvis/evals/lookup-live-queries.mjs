import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { runLookup } from '../src/agent/lookup/runner.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';

export const LOOKUP_LIVE_CASES = [
  ['sports', '体育资讯', 'sports_news'], ['recent-sports', '最近体育资讯', 'sports_news'],
  ['today', '今日新闻', 'news'], ['world', '国际新闻', 'news'], ['finance', '财经早报', 'news'], ['tech', '科技资讯', 'news'],
  ['no-scores', '给我体育资讯，不要比分', 'sports_news'], ['complaint', '发个新闻那么慢', 'meta'], ['status', '你在干嘛', 'meta'],
  ['weather', '今天天气', 'weather'], ['football', '足彩赛程', 'sports_live'], ['market', '今天大盘怎么样', 'market'],
  ['weather-alias', '集团年天气', 'weather'], ['general', 'gpt-sol 最便宜的中转平台', 'general'], ['followup', '各三条', 'news']
];
/** 真实查询取数，不读取生产配置/健康/密钥、不请求模型；非新闻类别明确留第2步。 */
export async function runLookupLiveQueries({ out, signal, declaredRegion, script }) {
  const service = createLookupService({ storage: memoryLookupStorage() });
  const cases = [];
  for (const [id, text, expected] of LOOKUP_LIVE_CASES) {
    if (signal.aborted) throw signal.reason;
    const intent = lookupIntent(text, id === 'followup' ? { history: [{ role: 'user', content: '今日新闻' }] } : {});
    const row = { id, text, expected, actual: intent.kind, intentCorrect: expected === intent.kind };
    if (!['news', 'sports_news'].includes(intent.kind)) {
      cases.push({ ...row, state: intent.kind === 'meta' ? 'not_lookup' : 'pending_step2', modelRequested: false });
      console.log(`${id}：${intent.kind}；${intent.kind === 'meta' ? '不联网' : '留第2步接入，不冒充本步验收'}`);
      continue;
    }
    console.log(`${id}：开始真实读取（最多8读，每源总8秒）`);
    const started = performance.now();
    const retrieval = createRetrievalBudget(text);
    retrieval.begin();
    try {
      const value = await runLookup(intent, { ...service.options('cn'), signal, retrieval });
      const elapsedMs = Math.round(performance.now() - started);
      cases.push({ ...row, state: 'fetched', elapsedMs, items: value.items, failures: value.failures, skipped: value.skipped,
        reads: retrieval.resources.read, modelRequested: false, note: '这是取数耗时，不是含模型回答的总完成耗时' });
      console.log(`${id}：${value.items.length}条；取数${elapsedMs}ms；读取${retrieval.resources.read}次`);
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw error;
      cases.push({ ...row, state: 'failed', code: error.code, reason: String(error.message).slice(0, 160), modelRequested: false });
      console.log(`${id}：失败；${error.code || error.name}`);
    }
  }
  const summary = { version: 1, scope: 'step1_news_runner_no_model', strategyRegion: 'cn', declaredRegion, regionVerified: false,
    scriptSHA256: crypto.createHash('sha256').update(await fs.readFile(script)).digest('hex'),
    classifier: { total: cases.length, correct: cases.filter(row => row.intentCorrect).length },
    cases: cases.map(({ items, ...row }) => ({ ...row, count: items?.length || 0 })),
    required: ['sports', 'world'].map(id => ({ id, count: cases.find(row => row.id === id)?.items?.length || 0, minimum: 5 })),
    productionChanged: false, modelRequested: false, note: '新闻真实取数+15条意图表；天气/赛程/行情/一般查询留第2步，不等于15题模型问答或30题完成验收' };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ ...summary, cases }, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`意图判断：${summary.classifier.correct}/${cases.length}；体育${summary.required[0].count}条；国际${summary.required[1].count}条`);
  console.log('查询摘要：' + path.join(out, 'summary.json'));
  console.log('私有查询报告：' + path.join(out, 'report.json'));
  return summary;
}
