/**
 * 30 题联合复测的自动评审员：按 joint-rubric.mjs 的同一把尺子给每次运行打分、写依据、标“说做到没做到”和失败主因。
 * 在未央服务器上运行（读服务器的模型配置，Key 不打印、不写报告）。
 *
 *   node evals/joint-judge.mjs 报告.json [--judge=服务商::型号]
 *
 * 不指定时用能力表里“推理”那一项（一般是最强的）；和答题模型相同时报告里会标出来——自己评自己可能偏高。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapter } from '../src/llm/config.js';
import { routeFor } from '../src/llm/router.js';
import { createHelperLlm } from '../src/llm/helper.js';
import { judgePrompt, parseJudgement, rubricVersion } from './joint-rubric.mjs';
import { stability, jointSummary } from './joint-report.mjs';

/** 选评审模型：显式指定 > 能力表“推理” > 当前主模型 */
export function judgeConfig(cfg, wanted = '') {
  const [provider, ...rest] = String(wanted).split('::');
  if (provider && rest.length) return { ...cfg, provider, models: { ...cfg.models, [provider]: rest.join('::') }, routing: { enabled: false } };
  return routeFor(cfg, 'reason').cfg;
}

/** 给一次运行评分；输出格式不对重试一次，还不对就记 error，不猜分 */
export async function judgeRun(llm, item, run, { signal } = {}) {
  const { system, prompt } = judgePrompt(item, run);
  for (let i = 0; i < 2; i++) {
    const text = await llm({ system, prompt: i ? prompt + '\n\n（上次输出格式不对：只输出一个 JSON 对象。）' : prompt, signal, allowWebSearch: false, maxTransientRetries: 1 });
    const parsed = parseJudgement(text, item);
    if (!parsed.error) return parsed;
    if (i === 1) return parsed;
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw Object.assign(new Error('用法：node evals/joint-judge.mjs 报告.json [--judge=服务商::型号]'), { code: 'EVAL_CONFIG' });
  const dataDir = env.JARVIS_DATA || '/opt/jarvis/data';
  const cfg = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  const chosen = judgeConfig(cfg, args.find((a) => a.startsWith('--judge='))?.slice(8));
  const { adapter, model, problem } = createAdapter(chosen);
  if (problem || !adapter) throw Object.assign(new Error('评审模型不可用：' + (problem || '没有配置')), { code: 'EVAL_CONFIG' });
  const llm = createHelperLlm(adapter, model);
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  report.judge = { provider: chosen.provider, model, rubricVersion, sameAsAnswerModel: model === report.conditions?.model, judgedAt: new Date().toISOString() };
  for (const entry of report.results) {
    for (const run of entry.runs) {
      if (run.environment === 'not_ready' || !run.turns?.length) continue;
      try {
        run.judgement = await judgeRun(llm, entry, run);
      } catch (error) {
        run.judgement = { error: '评审调用失败：' + String(error.message || error).slice(0, 120) };
      }
      console.log(`${entry.id} 第${run.attempt}次：${run.judgement.error ? run.judgement.error : `${run.judgement.pass ? '通过' : '不通过'}，${run.judgement.total}/20${run.judgement.overclaim ? '，说做到没做到' : ''}`}`);
    }
    entry.stability = stability(entry.runs);
    await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  report.summary = jointSummary(report.results);
  await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`评审完成（${model}${report.judge.sameAsAnswerModel ? '，和答题模型相同，分数可能偏高' : ''}）。下一步：node evals/joint-calibrate.mjs sample ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.code === 'EVAL_CONFIG' ? error.message : '评审没跑完；已评的部分保存在报告里。');
    process.exitCode = 1;
  });
}
