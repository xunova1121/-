/**
 * 智能体专业能力评测：40 道题（agent-cases.mjs）按各自智能体发到未央服务器，保存回答和评分要点，供人工或评审模型打分。
 *   node evals/agents.mjs                         只列出题目（不联网、不调用模型）
 *   JARVIS_EVAL_URL=… JARVIS_EVAL_TOKEN=… node evals/agents.mjs --live --out-dir=/全新私有目录 [--ids=agent-01,agent-02] [--label=改前]
 * 令牌只放环境变量，不写进报告；服务器忙时不执行。改专业技能说明前后各跑一次，用 --label 区分再对比。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCase, serverAPI } from './runner.mjs';
import { validateLiveConfig } from './baseline.mjs';
import { agentCases, agentSuiteVersion } from './agent-cases.mjs';

export function pickCases(ids) {
  const cases = ids ? ids.map((id) => agentCases.find((c) => c.id === id) || (() => { throw new Error(`未知题号：${id}`); })()) : agentCases;
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('题号重复');
  return cases;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const ids = args.find((x) => x.startsWith('--ids='))?.slice(6).split(',');
  const cases = pickCases(ids);
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ suite: agentSuiteVersion, mode: 'plan_only', count: cases.length, cases }, null, 2));
    return;
  }
  if (!env.JARVIS_EVAL_TOKEN) throw new Error('缺少服务器登录令牌');
  const api = serverAPI(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  const config = validateLiveConfig(await api('/api/server/config'));
  const status = await api('/api/server/status');
  if (status.running || status.tasks?.length || !status.features?.evaluationMemoryIsolation || !status.features?.taskRequestIds) throw new Error('服务器忙或缺少独立评测隔离，未执行');
  const directory = args.find((x) => x.startsWith('--out-dir='))?.slice(10);
  if (!directory) throw new Error('请指定全新私有报告目录');
  await fs.mkdir(directory, { mode: 0o700 });
  const runId = randomUUID();
  const report = { suite: agentSuiteVersion, ...config, label: args.find((x) => x.startsWith('--label='))?.slice(8, 88) || '', runId, startedAt: new Date().toISOString(), results: [] };
  for (const item of cases) {
    const turn = await runCase(api, item, { runId, evaluationId: `${runId}_${item.id}` });
    report.results.push({ id: item.id, agentId: item.agentId, title: item.title, rubric: item.rubric, status: turn.status, answer: turn.answer ?? turn.text ?? '', files: turn.files ?? [], ms: turn.ms ?? null, quality: turn.status === 'done' ? 'not_reviewed' : 'execution_failed' });
    await fs.writeFile(path.join(directory, 'agents-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'agents-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`完成 ${report.results.filter((r) => r.status === 'done').length}/${report.results.length} 题；回答和评分要点在 ${directory}/agents-report.json，需人工或评审模型按要点打分`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
