/** 用户服务器15题验收：每题一次，保持模型配置；专用令牌只从环境读取。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serverAPI, runCase } from './runner.mjs';
import { evaluationInfo } from './evaluation-auth.mjs';

const arg = key => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const version = arg('expected-version');
if (!process.argv.includes('--live') || !/^1\.0\.\d+$/.test(version || '') || !process.env.JARVIS_EVAL_TOKEN) {
  console.error('需要 --live --expected-version=实际已升级版本；评测专用令牌仅通过JARVIS_EVAL_TOKEN传入。未请求模型。');
  process.exit(1);
}
const out = path.resolve(arg('out-dir') || `/tmp/weiyang-market-time-${Date.now()}`);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const questions = [
  '今天大盘的情况', '今天金价多少', '茅台股价', '美元汇率', '美股怎么样', '恒生指数', '今天油价',
  '23小时后是几点', '90分钟后几点', '距离春节还有几天', '下周五是几号', '纽约现在几点',
  '今天到12月31日有几个工作日', '100斤是多少公斤', '贷款100万30年利率3.1%月供多少'
];
const report = { version: 1, expectedVersion: version, startedAt: new Date().toISOString(), state: 'not_started', realModelRequested: false,
  note: '执行done不代表质量通过；数字/来源标记需人工核对时点、单位和准确性。油价按设计搜索；其他搜索是否属于报价失败回退需读原执行记录。',
  cases: questions.map((question, i) => ({ id: `market-time-${i + 1}`, question, state: 'not_run', quality: 'not_reviewed' })) };
const save = () => fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
await save();
try {
  const api = serverAPI(process.env.JARVIS_EVAL_URL || 'http://127.0.0.1:8787', process.env.JARVIS_EVAL_TOKEN);
  const runId = randomUUID();
  for (const row of report.cases) {
    if (controller.signal.aborted) break;
    // 每题前检查版本和占用，不自动重试未知提交，不改主人配置和访问密码。
    const info = await evaluationInfo(api);
    if (info.version !== version || !info.provider || info.provider === 'mock') throw new Error('readiness');
    if (report.model && (report.model !== info.model || report.provider !== info.provider)) throw new Error('model_changed');
    report.model = info.model; report.provider = info.provider;
    report.state = 'running'; report.realModelRequested = true; row.state = 'submitting';
    await save();
    console.log(`${row.question}：开始，每题最多120秒`);
    const result = await runCase(api, { id: row.id, prompt: row.question, category: 'market-time-live', rubric: [], targetMs: 45000, timeoutMs: 120000 }, { runId, evaluationId: runId, signal: controller.signal });
    row.state = result.status; row.result = result;
    row.numberTextPresent = /\d/.test(result.answer || '');
    row.sourceNamesInAnswer = ['腾讯行情', '东方财富', 'ExchangeRate-API'].filter(name => result.answer?.includes(name));
    const tools = Object.entries(result.timing?.tools || {});
    row.searchToolCalled = result.timing ? tools.some(([name]) => /search|fetch_url|read_url|get_today_news/.test(name)) || (result.timing.nativeSearchCalls || 0) > 0 : null;
    row.quoteToolFailed = tools.some(([name, stats]) => /get_market_quote|get_stock_kline/.test(name) && stats.failed > 0);
    row.searchFallback = row.question === '今天油价' ? 'search_by_design' : row.searchToolCalled === true ? 'requires_trace_review' : row.searchToolCalled === false ? 'no_search_recorded' : 'unknown';
    console.log(`${row.question}：${row.state}；${Math.round(result.clientTotalMs / 1000)}秒；来源：${row.sourceNamesInAnswer.join('/') || '待核对'}；搜索：${row.searchToolCalled}`);
    await save();
    if (result.status !== 'done') break;
  }
  report.state = report.cases.every(row => row.state === 'done') ? 'completed_pending_review' : 'incomplete';
} catch {
  report.state = 'blocked_or_error';
  console.error('预检或连接失败：核对服务版本、其他任务、评测专用授权和额度；没有自动重发，没有输出凭据。');
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(`私有报告：${path.join(out, 'report.json')}；真实回答须逐题复核，未执行不能记通过。`);
}
