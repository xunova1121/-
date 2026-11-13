import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCase, serverAPI } from './runner.mjs';
import { validateLiveConfig } from './baseline.mjs';
import { communicationCases, communicationSuiteVersion } from './communication-cases.mjs';
/** 每题独立评测记忆，同题多轮同会话；不靠温柔词自动判语义通过。 */
export async function runCommunicationCase(api, item, options = {}) {
  const turns = [];
  const evaluationId = options.evaluationId || `${options.runId || randomUUID()}_${item.id}`;
  for (const prompt of item.turns) {
    const turn = await runCase(api, { ...item, prompt }, { ...options, evaluationId, ...(turns.length && { sessionId: turns[0].sessionId }) });
    turns.push(turn);
    if (turn.status !== 'done' || turn.cleanupWarning || options.signal?.aborted) break;
  }
  return {
    id: item.id,
    title: item.title,
    rubric: item.rubric,
    turns,
    quality: turns.length === item.turns.length && turns.every((t) => t.status === 'done') ? 'not_reviewed' : 'execution_failed'
  };
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const ids = args
    .find((x) => x.startsWith('--ids='))
    ?.slice(6)
    .split(',');
  const cases = ids
    ? ids.map((id) => {
        const item = communicationCases.find((item) => item.id === id);
        if (!item) throw new Error('未知题号');
        return item;
      })
    : communicationCases;
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error('题号重复');
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ suite: communicationSuiteVersion, mode: 'plan_only', cases }, null, 2));
    return;
  }
  const api = serverAPI(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  if (!env.JARVIS_EVAL_TOKEN) throw new Error('缺少服务器登录令牌');
  const config = validateLiveConfig(await api('/api/server/config'));
  const status = await api('/api/server/status');
  if (status.running || status.tasks?.length || !status.features?.evaluationMemoryIsolation || !status.features?.taskRequestIds)
    throw new Error('服务器忙或缺少独立评测隔离，未执行');
  const update = await api('/api/server/update').catch(() => null);
  const serverVersion = typeof update?.version === 'string' ? update.version.slice(0, 40) : null;
  const directory = args.find((x) => x.startsWith('--out-dir='))?.slice(10);
  if (!directory) throw new Error('请指定全新私有报告目录');
  await fs.mkdir(directory, { mode: 0o700 });
  const report = {
    suite: communicationSuiteVersion,
    serverVersion,
    ...config,
    label: args.find((x) => x.startsWith('--label='))?.slice(8, 88) || '',
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    results: [],
    semanticReview: 'not_reviewed',
    limitations: [
      '不改服务商/模型配置；同题记忆隔离，完整回答只在私有报告中。',
      '配置不证明真实上游；回退或分工须标记混合模型。',
      '按理解、依据、具体共情、指令连续性、可执行表达人工复核；不以温柔词出现计为通过。'
    ]
  };
  const destination = path.join(directory, 'report.json');
  const save = () => fs.writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
  await save();
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const item of cases) {
      if (controller.signal.aborted) break;
      const result = await runCommunicationCase(api, item, { runId: report.runId, signal: controller.signal });
      report.results.push(result);
      report.mixedModel = Boolean(config.routingEnabled) || report.results.some((item) => item.turns.some((turn) => turn.timing?.fallbacks > 0));
      await save();
      console.log(`${item.id}: ${result.quality}; ${result.turns.reduce((n, t) => n + (t.clientTotalMs || 0), 0)}ms`);
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('评测未完成，请核查登录、配置、隔离能力和私有报告；未打印凭据或回答。');
    process.exitCode = 1;
  });
