/** 国内网络只读来源预检：不读生产配置/Key、不请求模型、不安装依赖、不更新正式服务。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DOMESTIC_NEWS_CANDIDATES } from '../src/agent/lookup/sourceCatalog.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { LOOKUP_INTENT_EXAMPLES } from '../src/agent/lookup/intentExamples.js';
import { readLookupSource } from '../src/agent/lookup/readSource.js';
import { runLookupFaults } from './lookup-live-faults.mjs';
import { runLookupLiveQueries } from './lookup-live-queries.mjs';

export async function runLookupLive(args = process.argv.slice(2)) {
  const declaredRegion = args.find(a => a.startsWith('--network='))?.slice(10) || 'unspecified';
  if (!['cn', 'global', 'unspecified'].includes(declaredRegion)) throw Error('--network只接受cn/global');
  const out = args.find(a => a.startsWith('--out-dir='))?.slice(10) || await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-lookup-sources-'));
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const ctrl = new AbortController(); const stop = () => ctrl.abort(Object.assign(new Error('用户停止'), { name: 'AbortError' }));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const started = new Date().toISOString(), now = Date.now(), rows = [];
  let next = 0;
  const worker = async () => {
    while (next < DOMESTIC_NEWS_CANDIDATES.length && !ctrl.signal.aborted) {
      const source = DOMESTIC_NEWS_CANDIDATES[next++];
      const params = source.kind === 'sports_news' ? { dateMode: 'recent24h', categories: ['体育'] } : { dateMode: 'today', categories: [] };
      const result = await readLookupSource(source, { now, params, signal: ctrl.signal, detailLimit: 5 });
      rows.push({ ...result, items: result.items.map(({ title, url, publishedAt, category, verified }) => ({ title, url, publishedAt, category, verified })) });
      console.log(`${source.label}：${result.state}；${result.elapsedMs}ms；${result.items.length}条${result.reason ? '；' + result.reason : ''}`);
    }
  };
  try {
    console.log('只读来源实测：不读取未央配置、不调用模型、不更新正式服务。');
    console.log('网络地区为执行者声明，脚本不会把时区或HTTP200当作国内网络证明。');
    if (args.includes('--faults')) return await runLookupFaults({ out, signal: ctrl.signal, declaredRegion, only: args.find(a => a.startsWith('--only='))?.slice(7) });
    if (args.includes('--queries')) return await runLookupLiveQueries({ out, signal: ctrl.signal, declaredRegion, script: fileURLToPath(import.meta.url), only: args.find(a => a.startsWith('--only='))?.slice(7) });
    await Promise.all(Array.from({ length: 3 }, worker));
    const classification = LOOKUP_INTENT_EXAMPLES.map(({ text, kind }) => { const actual = lookupIntent(text); return { text, expected: kind, actual: actual.kind, ok: actual.kind === kind }; });
    const scriptHash = crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
    const report = { version: 1, scope: 'step1_sources_and_intent_only', startedAt: started, endedAt: new Date().toISOString(), declaredRegion, regionVerified: false,
      environment: { platform: process.platform, node: process.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, httpProxyConfigured: Boolean(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) },
      scriptSHA256: scriptHash, classifier: { total: classification.length, passed: classification.filter(x => x.ok).length, cases: classification }, sources: rows,
      note: '这是来源与离线意图预检，不是完整模型/各类查询耗时验收；国内声明与报告需由用户/Claude核实，不能据此自动启用来源。' };
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    const summary = { scope: report.scope, startedAt: started, scriptSHA256: scriptHash, declaredRegion, regionVerified: false, environment: report.environment,
      classifier: { total: classification.length, passed: report.classifier.passed }, sources: rows.map(({ items, ...row }) => ({ ...row, count: items.length })),
      sourceOnly: true, productionChanged: false };
    await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.log(`意图判定：${summary.classifier.passed}/${summary.classifier.total}；脚本SHA256：${scriptHash}`);
    console.log('来源摘要：' + path.join(out, 'summary.json'));
    console.log('完整来源报告：' + path.join(out, 'report.json'));
    return summary;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runLookupLive().catch(error => { console.error(error.name === 'AbortError' ? '已停止，未更新正式服务。' : error.message); process.exitCode = 1; });
