import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { runLookup } from '../src/agent/lookup/runner.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { lookupPublicQuery } from './lookup-public-query.mjs';

export const LOOKUP_LIVE_CASES = [
  ['sports', '体育资讯', 'sports_news'], ['recent-sports', '最近体育资讯', 'sports_news'],
  ['today', '今日新闻', 'news'], ['world', '国际新闻', 'news'], ['finance', '财经早报', 'news'], ['tech', '科技资讯', 'news'],
  ['no-scores', '给我体育资讯，不要比分', 'sports_news'], ['complaint', '发个新闻那么慢', 'meta'], ['status', '你在干嘛', 'meta'],
  ['weather', '今天天气', 'weather'], ['football', '足彩赛程', 'sports_live'], ['market', '今天大盘怎么样', 'market'],
  ['weather-alias', '集团年天气', 'weather'], ['general', 'gpt-sol 最便宜的中转平台', 'general'], ['followup', '各三条', 'news']
];
export function selectLiveLookupCases(only) {
  if (!only) return LOOKUP_LIVE_CASES;
  const selected = LOOKUP_LIVE_CASES.filter(row => row[0] === only);
  if (!selected.length) throw new Error('--only必须是问法表编号，例如tech；未发起网络请求');
  return selected;
}
/** 真实查询取数，不读取生产配置/健康/密钥、不请求模型。公开通道不冒充用户的和风/博查账号。 */
export async function runLookupLiveQueries({ out, signal, declaredRegion, script, only }) {
  const selected = selectLiveLookupCases(only);
  const service = createLookupService({ storage: memoryLookupStorage() });
  const cases = [];
  for (const [id, text, expected] of selected) {
    if (signal.aborted) throw signal.reason;
    const intent = lookupIntent(text, id === 'followup' ? { history: [{ role: 'user', content: '今日新闻' }] } : {});
    const row = { id, text, expected, actual: intent.kind, intentCorrect: expected === intent.kind };
    if (!['news', 'sports_news'].includes(intent.kind)) {
      if (intent.kind === 'meta') {
        cases.push({ ...row, state: 'not_lookup', modelRequested: false });
        console.log(`${id}：meta；不联网`);
      } else {
        const started = performance.now();
        const result = await lookupPublicQuery(text, intent, { service, signal });
        cases.push({ ...row, ...result, elapsedMs: Math.round(performance.now() - started) });
        console.log(`${id}：${result.state}；${result.items.length}条；取数${cases.at(-1).elapsedMs}ms`);
      }
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
  const summary = { version: 1, scope: 'unified_lookup_public_no_model', strategyRegion: 'cn', declaredRegion, regionVerified: false,
    scriptSHA256: crypto.createHash('sha256').update(await fs.readFile(script)).digest('hex'),
    classifier: { total: cases.length, correct: cases.filter(row => row.intentCorrect).length },
    cases: cases.map(({ items, ...row }) => ({ ...row, count: items?.length || 0 })),
    selection: selected.map(row => row[0]),
    required: cases.filter(row => ['sports', 'world', 'tech'].includes(row.id)).map(row => ({ id: row.id, count: row.items?.length || 0, minimum: row.id === 'tech' ? 1 : 5 })),
    productionChanged: false, modelRequested: false, note: `统一runner公开取数+所选${cases.length}/15条意图；未选题不算通过。缺城市必须追问；无Key探测不代表用户已配置的和风/博查服务验收，不等于含模型问答或30题完成验收` };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ ...summary, cases }, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`意图判断：${summary.classifier.correct}/${cases.length}；` + summary.required.map(row => `${{ sports: '体育', world: '国际', tech: '科技' }[row.id]}${row.count}条`).join('；'));
  console.log('查询摘要：' + path.join(out, 'summary.json'));
  console.log('私有查询报告：' + path.join(out, 'report.json'));
  return summary;
}
