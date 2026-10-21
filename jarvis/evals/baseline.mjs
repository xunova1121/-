import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { baselineCases, suiteVersion } from './baseline-cases.mjs';
import { runCase, serverAPI } from './runner.mjs';
import { baselineSummary, checkResult, metricsFor } from './baseline-report.mjs';

/** 不改生产配置。混合分工或第三方线路不得冒充DeepSeek官方单模型基线。 */
export function validateBaselineConfig(cfg) {
  if (cfg.provider !== 'deepseek') throw new Error('基线需选DeepSeek官方服务商');
  if (cfg.routing?.enabled) throw new Error('基线需关闭分工，避免各题用不同模型');
  if (!cfg.models?.deepseek) throw new Error('请明确选择DeepSeek型号');
  if (cfg.tavilyKey || cfg.bochaKey) throw new Error('本轮不使用第三方搜索API，请先在设置中关闭');
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
  if (!env.JARVIS_EVAL_URL || !env.JARVIS_EVAL_TOKEN) throw new Error('缺少服务器地址或登录令牌');
  const api = serverAPI(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  const cfg = await api('/api/server/config');
  const selected = validateBaselineConfig(cfg);
  const status = await api('/api/server/status');
  if (status.running || status.tasks?.length) throw new Error('服务器有其他任务，请单独评测');
  if (!status.features?.taskRequestIds) throw new Error('服务器不支持独立评测任务');
  const directory = args.find((arg) => arg.startsWith('--out-dir='))?.slice(10);
  if (!directory) throw new Error('请指定全新的--out-dir私有报告目录');
  await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, suiteVersion, ...selected, location: new URL(env.JARVIS_EVAL_URL).origin, startedAt: new Date().toISOString(), runId: randomUUID(), results: [], limitations: ['未做语义复核不能计为通过；Office文件必须下载打开与校验。', '统计主循环及工具辅助逻辑调用，正文字符不含系统提示和工具schema；不是全部HTTP请求或Token。', '配置验证不证明每一请求的上游；回退发生时必须标记混合模型，不能作为单模型对照。'] };
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
      const result = await runBaselineCase(api, item, { runId: report.runId, signal: controller.signal });
      report.results.push(result);
      report.summary = baselineSummary(report.results);
      report.mixedModel = report.results.some((entry) => entry.turns.some((turn) => turn.timing?.fallbacks > 0));
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
  main().catch(() => {
    console.error('基线未完成；请检查服务器登录、DeepSeek配置和私有报告。不输出凭据或响应正文。');
    process.exitCode = 1;
  });
}
