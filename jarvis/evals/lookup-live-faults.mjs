import fs from 'node:fs/promises';
import path from 'node:path';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { lookupPublicQuery } from './lookup-public-query.mjs';
import { withWebDeadline } from '../src/agent/lookup/request.js';
export const FAULT_CASES = [
  ['weather', '南京今天天气'], ['sports_live', '今天足球赛程'], ['news', '今日新闻'],
  ['sports_news', '体育资讯'], ['market', '600519收盘价'], ['general', '神舟飞船最新发射消息是什么']
];
/** 仅此只读评测内替换首个来源域名，生产地址与配置均不改；保留实际失败与备用请求证据。 */
export function faultFetch(get = (...args) => fetch(...args)) {
  let primaryHost; const attempts = [];
  const read = async (url, init = {}) => {
    primaryHost ||= new URL(url).hostname;
    const injected = new URL(url).hostname === primaryHost;
    const target = injected ? 'https://weiyang-unreachable.invalid/' : url;
    const row = { sourceHost: new URL(url).hostname, injected, startedAt: new Date().toISOString() };
    attempts.push(row);
    try {
      const response = await withWebDeadline(signal => get(target, { ...init, signal }), { signal: init.signal, timeoutMs: injected ? 1000 : 5000 });
      row.status = response.status; return response;
    } catch (error) { row.error = error.name; throw error; }
  };
  return { get: read, attempts };
}
export async function runLookupFaults({ out, signal, declaredRegion, only, get }) {
  const selected = only ? FAULT_CASES.filter(row => row[0] === only) : FAULT_CASES;
  if (!selected.length) throw new Error('--only须为weather/sports_live/news/sports_news/market/general');
  const cases = [];
  for (const [kind, text] of selected) {
    if (signal.aborted) throw signal.reason;
    const fault = faultFetch(get);
    const service = createLookupService({ storage: memoryLookupStorage(), get: fault.get });
    const started = performance.now();
    // general明确使用搜索，不把分类器给新闻的判定当作一般问题覆盖。
    const intent = kind === 'general' ? { kind, lookup: true, sure: true, params: {} } : lookupIntent(text);
    const result = await lookupPublicQuery(text, intent, { service, signal, get: fault.get, includeGeneral: true });
    const passed = result.items.length > 0 && fault.attempts.some(r => r.injected) && fault.attempts.some(r => !r.injected && r.status >= 200 && r.status < 300);
    cases.push({ kind, passed, ...result, elapsedMs: Math.round(performance.now() - started), attempts: fault.attempts });
    console.log(`${kind}：${passed ? '备用取得数据' : '未通过，查看报告'}；${result.items.length}条；${cases.at(-1).elapsedMs}ms`);
  }
  const report = { scope: 'public_lookup_primary_fault_injection', declaredRegion, regionVerified: false, modelRequested: false,
    productionChanged: false, productionCacheAccessed: false, cases, note: '不读正式配置、和风密钥或正式缓存；只证明当前网络公开查询自救，非用户账号/模型语义或真机验收。' };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const summary = { ...report, cases: cases.map(({ items, ...row }) => ({ ...row, count: items.length })), passed: cases.filter(r => r.passed).length, total: cases.length };
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`故障自救：${summary.passed}/${summary.total}；摘要：${path.join(out, 'summary.json')}`);
  return summary;
}
