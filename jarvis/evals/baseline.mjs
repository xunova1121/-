import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { baselineCases, suiteVersion } from './baseline-cases.mjs';
import { runCase, serverAPI } from './runner.mjs';
import { baselineSummary, checkResult, metricsFor, assessmentVersion } from './baseline-report.mjs';

/** 默认测当前选择，不改生产配置；官方单模型对照通过显式参数启用。 */
export function validateLiveConfig(cfg) {
  const provider = String(cfg.provider || '');
  const model = cfg.models?.[provider];
  if (!provider || provider === 'mock' || typeof model !== 'string' || !model.trim()) throw Object.assign(new Error('请在服务器明确选择真实服务商及模型后再评测'), { code: 'EVAL_CONFIG', kind: 'api' });
  return { provider, model, routingEnabled: Boolean(cfg.routing?.enabled) };
}

/** 不改生产配置。混合分工或第三方线路不得冒充DeepSeek官方单模型基线。 */
export function validateBaselineConfig(cfg) {
  if (cfg.provider !== 'deepseek') throw Object.assign(new Error('基线需选DeepSeek官方服务商'), { code: 'EVAL_CONFIG', kind: 'api' });
  if (cfg.routing?.enabled) throw Object.assign(new Error('基线需关闭分工，避免各题用不同模型'), { code: 'EVAL_CONFIG', kind: 'api' });
  if (!cfg.models?.deepseek) throw Object.assign(new Error('请明确选择DeepSeek型号'), { code: 'EVAL_CONFIG', kind: 'api' });
  if (cfg.tavilyKey || cfg.bochaKey) throw Object.assign(new Error('本轮不使用第三方搜索API，请先在设置中关闭'), { code: 'EVAL_CONFIG', kind: 'api' });
  return { provider: 'deepseek', model: cfg.models.deepseek };
}

export async function runBaselineCase(api, item, options = {}) {
  const turns = [await runCase(api, item, options)];
  const initial = turns[0];
  if (item.followup && initial.status === 'done' && !options.signal?.aborted) {
    turns.push(await runCase(api, { ...item, prompt: item.followup }, { ...options, sessionId: initial.sessionId }));
  }
  const last = turns.at(-1);
  const assessment = checkResult(item, last);
  if (item.followup && turns.length !== 2) {
    assessment.failures.push('未完成同会话纠正');
    assessment.mechanical = 'failed';
    assessment.quality = 'failed';
  }
  return { id: item.id, category: item.category, status: last.status, quality: assessment.quality, assessment, rubric: item.rubric, metrics: metricsFor(item, turns), turns };
}

/** 私有报告保留回答供复核；标准输出只打印题号与数字，目录独占且不覆盖旧报告。 */
export async function main(args = process.argv.slice(2), env = process.env) {
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ mode: 'plan_only', suiteVersion, cases: baselineCases }, null, 2));
    return;
  }
  if (!env.JARVIS_EVAL_URL || !env.JARVIS_EVAL_TOKEN) throw Object.assign(new Error('缺少服务器地址或登录令牌'), { code: 'EVAL_CONFIG', kind: 'api' });
  const api = serverAPI(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  const cfg = await api('/api/server/config');
  const selected = args.includes('--official-deepseek') ? validateBaselineConfig(cfg) : validateLiveConfig(cfg);
  const serverStatus = await api('/api/server/status');
  if (serverStatus.running || serverStatus.tasks?.length) throw Object.assign(new Error('服务器有其他任务，请单独评测'), { code: 'EVAL_CONFIG', kind: 'api' });
  if (!serverStatus.features?.evaluationMemoryIsolation) throw Object.assign(new Error('服务器缺少评测记忆隔离，请更新服务器后再测；不向旧服务器提交测试任务'), { code: 'EVAL_CONFIG', kind: 'api' });
  if (!serverStatus.features?.taskRequestIds) throw Object.assign(new Error('服务器不支持独立评测任务'), { code: 'EVAL_CONFIG', kind: 'api' });
  const update = await api('/api/server/update').catch(() => null);
  const serverVersion = typeof update?.version === 'string' && /^\d+\.\d+\.\d+$/.test(update.version) ? update.version : null;
  const directory = args.find((arg) => arg.startsWith('--out-dir='))?.slice(10);
  if (!directory) throw Object.assign(new Error('请指定全新的--out-dir私有报告目录'), { code: 'EVAL_CONFIG', kind: 'api' });
  await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, suiteVersion, assessmentVersion, executionProfile: 'server_memory_write_isolated_v1', serverVersion, ...selected, location: new URL(env.JARVIS_EVAL_URL).origin, startedAt: new Date().toISOString(), runId: randomUUID(), results: [], limitations: ['未做语义复核不能计为通过；Office文件必须下载打开与校验。', '统计主循环及工具辅助逻辑调用，正文字符不含系统提示和工具schema；不是全部HTTP请求或Token。', '配置验证不证明每一请求的上游；回退发生时必须标记混合模型，不能作为单模型对照。'] };
  const destination = path.join(directory, 'report.json');
  const save = () => fs.writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
  await save();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const item of baselineCases) {
      if (controller.signal.aborted) break;
      const result = await runBaselineCase(api, item, { runId: report.runId, evaluationId: report.runId, signal: controller.signal });
      report.results.push(result);
      report.summary = baselineSummary(report.results);
      report.mixedModel = Boolean(selected.routingEnabled) || report.results.some((entry) => entry.turns.some((turn) => turn.timing?.fallbacks > 0));
      await save();
      console.log(`${item.id}: ${result.status}; ${result.metrics.totalMs}ms; ${result.quality}`);
      if (result.turns.some((turn) => turn.status === 'submission_unknown' || turn.cleanupWarning)) break;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    report.finishedAt = new Date().toISOString();
    await save();
  }
  console.log(`私有报告：${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.code === 'EVAL_CONFIG' ? error.message : '基线未完成；请检查服务器登录、连接和私有报告，未输出凭据或响应正文。');
    process.exitCode = 1;
  });
}
