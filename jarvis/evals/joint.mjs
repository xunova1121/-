/**
 * 30 题联合复测：每题跑两次，每轮之后把交付的文件下载回来量一遍；记调用明细、时间拆分、Token、费用。
 * 评分另由 joint-judge.mjs 自动评审、joint-calibrate.mjs 和用户抽查对比校准。
 *
 *   node evals/joint.mjs                          只打印题目（不连服务器）
 *   node evals/joint.mjs --live --out-dir=目录 [--previous=上一轮报告.json] [--baseline=老30题报告.json] [--only=joint-01,joint-02] [--prices=价格.json]
 *
 * 不改生产配置；记忆写入按评测隔离；第 22 题建的提醒测完立刻删掉；代码题只在新分支改、不推送。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { jointCases, jointSuiteVersion, JOINT_REPEATS } from './joint-cases.mjs';
import { runCase, serverAPI } from './runner.mjs';
import { checkResult } from './baseline-report.mjs';
import { validateLiveConfig } from './baseline.mjs';
import { fileDownloader, turnFileFacts, fileProblems, turnEvidence } from './joint-files.mjs';
import { runMetrics, stability, jointSummary, compareRounds } from './joint-report.mjs';
import { rubricVersion } from './joint-rubric.mjs';

const bj = (t = Date.now()) => new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) + '（北京时间）';
const configError = (message) => Object.assign(new Error(message), { code: 'EVAL_CONFIG', kind: 'api' });

/** 运行前提：没连仓库 / 没配镜像的题记“环境未就绪”，不计分，也不提交任务 */
export function readiness(item, env) {
  if (item.requires.includes('repo') && !env.repoConnected) return '服务器没有连接测试仓库';
  if (item.requires.includes('browser') && !env.browserConfigured) return '服务器没有配置网页检查浏览器镜像';
  return '';
}

/** 一题跑一次（含追问）：每轮结束量一次文件 */
export async function runJointOnce(api, item, { download, runId, attempt, signal, prices = {}, cleanup }) {
  const turns = [];
  const fileFacts = [];
  // 服务器在评测会话里不给代码工具（安全隔离），代码题只能用普通会话：会出现在对话列表里，报告标 isolated:false
  const evaluationId = item.requires.includes('repo') ? null : runId;
  const first = await runCase(api, { ...item, id: `${item.id}-r${attempt}` }, { runId, evaluationId, signal });
  turns.push(first);
  if (item.file) fileFacts.push(await turnFileFacts(first, download));
  if (item.followup && first.status === 'done' && !signal?.aborted) {
    const next = await runCase(api, { ...item, id: `${item.id}-r${attempt}`, prompt: item.followup }, { runId, evaluationId, signal, sessionId: first.sessionId });
    turns.push(next);
    if (item.file) fileFacts.push(await turnFileFacts(next, download));
  }
  const createdSchedules = cleanup ? await cleanup().catch(() => []) : null;
  // 给评审员的证据：每轮用了哪些工具（次数 / 失败）、交付文件读回、建了哪些提醒（第一轮实测评审员看不到这些，误判了一批题）
  const evidence = [];
  for (const t of turns) evidence.push({ tools: Object.entries(t.timing?.tools || {}).map(([name, v]) => ({ name, calls: v.calls, failed: v.failed })), files: await turnEvidence(t, download).catch(() => []), outcome: t.review?.outcome ?? null });
  const last = turns.at(-1);
  const mechanical = checkResult(item, last);
  if (item.followup && turns.length !== 2) mechanical.failures.push('追问没跑成');
  const problems = item.file ? fileProblems(item.file, fileFacts) : [];
  return {
    attempt,
    status: last.status,
    environment: 'ready',
    isolated: Boolean(evaluationId),
    turns: turns.map((t) => ({ prompt: t.prompt, status: t.status, answer: t.answer, files: t.files, timing: t.timing, clientTotalMs: t.clientTotalMs, failure: t.failure || null, review: t.review || null })),
    mechanical: { mechanical: mechanical.failures.length ? 'failed' : 'passed', failures: mechanical.failures, warnings: mechanical.warnings },
    fileFacts: item.file ? fileFacts : null,
    evidence,
    ...(createdSchedules && { createdSchedules }),
    fileProblems: problems,
    metrics: runMetrics(turns, prices),
    judgement: null
  };
}

/** 第 22 题：删掉这一轮新建的提醒（名字或内容带“喝水”的、开跑后才有的）；删之前记下建了什么，给评审员当证据 */
export function scheduleCleaner(api, remove, before) {
  return async () => {
    const list = await api('/api/server/schedules');
    const created = (list || []).filter((s) => !before.has(s.id));
    for (const s of created) if (/喝水/.test(`${s.title || ''}${s.prompt || ''}`)) await remove(s.id);
    // 时间给北京时间的文字，不给毫秒数（第三轮实测：评审员自己换算时区算错 8 小时，把对的判成“说做到没做到”）
    const beijing = (t) => (Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : null);
    return created.map((s) => ({ title: String(s.title || '').slice(0, 60), kind: s.kind ?? null, time: s.time ?? null, at: beijing(s.at), nextRun: beijing(s.nextRun ?? s.next), enabled: s.enabled ?? null }));
  };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ mode: 'plan_only', suiteVersion: jointSuiteVersion, repeats: JOINT_REPEATS, cases: jointCases.map(({ id, group, prompt, followup, requires, carriedFrom }) => ({ id, group, prompt, followup, requires, carriedFrom })) }, null, 2));
    return;
  }
  if (!env.JARVIS_EVAL_URL || !env.JARVIS_EVAL_TOKEN) throw configError('缺少服务器地址或登录令牌');
  const api = serverAPI(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  const download = fileDownloader(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  const remove = async (id) => {
    const url = new URL(env.JARVIS_EVAL_URL);
    await fetch(new URL(url.pathname.replace(/\/$/, '') + '/api/server/schedules/' + encodeURIComponent(id), url.origin), { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${env.JARVIS_EVAL_TOKEN}` } });
  };
  const cfg = await api('/api/server/config');
  const selected = validateLiveConfig(cfg);
  const status = await api('/api/server/status');
  if (status.running || status.tasks?.length) throw configError('服务器有其他任务，请单独评测');
  if (!status.features?.evaluationMemoryIsolation || !status.features?.taskRequestIds) throw configError('服务器版本太旧（缺评测隔离），请先更新服务器');
  const update = await api('/api/server/update').catch(() => null);
  const repos = await api('/api/server/code-repos').catch(() => null);
  const envState = { repoConnected: repos?.connected === true && repos?.repository === 'xunova1121/weiyang-code-sandbox', browserConfigured: repos?.capabilities?.browserConfigured === true };
  const prices = arg('prices') ? JSON.parse(await fs.readFile(arg('prices'), 'utf8')) : {};
  const only = arg('only')?.split(',') || null;
  const repeats = Math.max(1, Math.min(3, Number(arg('repeats')) || JOINT_REPEATS));
  const directory = arg('out-dir');
  if (!directory) throw configError('请指定全新的 --out-dir 私有报告目录');
  await fs.mkdir(directory, { mode: 0o700 });
  const report = {
    schemaVersion: 1,
    suiteVersion: jointSuiteVersion,
    rubricVersion,
    repeats,
    runId: randomUUID(),
    // 固定运行条件：同一个服务器版本、同一套模型设置、同一时间段，耗时才能比
    conditions: {
      serverVersion: typeof update?.version === 'string' ? update.version : null,
      provider: selected.provider,
      model: selected.model,
      routingEnabled: selected.routingEnabled,
      routes: cfg.routing?.enabled ? cfg.routing.routes || null : null,
      environment: envState,
      startedAt: bj(),
      location: new URL(env.JARVIS_EVAL_URL).origin
    },
    pricesNote: Object.keys(prices).length ? '费用按 --prices 文件里的价格（元/百万Token）估算' : '没提供价格表，费用不算（不编价格）',
    results: []
  };
  const destination = path.join(directory, 'report.json');
  const save = () => fs.writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
  await save();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const item of jointCases.filter((c) => !only || only.includes(c.id))) {
      if (controller.signal.aborted) break;
      const entry = { id: item.id, group: item.group, category: item.category, carriedFrom: item.carriedFrom || null, prompt: item.prompt, followup: item.followup || null, rubric: item.rubric, runs: [] };
      report.results.push(entry);
      const notReady = readiness(item, envState);
      for (let attempt = 1; attempt <= repeats; attempt++) {
        if (controller.signal.aborted) break;
        if (notReady) {
          entry.runs.push({ attempt, status: 'skipped', environment: 'not_ready', reason: notReady, turns: [], metrics: runMetrics([]), judgement: null });
          continue;
        }
        const before = item.requires.includes('schedule') ? new Set(((await api('/api/server/schedules')) || []).map((s) => s.id)) : null;
        const run = await runJointOnce(api, item, { download, runId: report.runId, attempt, signal: controller.signal, prices, cleanup: before && scheduleCleaner(api, remove, before) });
        entry.runs.push(run);
        console.log(`${item.id} 第${attempt}次：${run.status}；${Math.round(run.metrics.totalMs / 1000)}秒；模型调用${run.metrics.allCalls ?? run.metrics.mainCalls ?? '?'}次${run.fileProblems.length ? '；文件不符' : ''}`);
        await save();
        if (run.turns.some((t) => t.status === 'submission_unknown')) controller.abort();
      }
      entry.stability = stability(entry.runs);
      report.summary = jointSummary(report.results);
      await save();
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    report.conditions.finishedAt = bj();
    report.summary = jointSummary(report.results);
    // 上一轮报告读不到（路径写错等）只提示，不能让 30 题白跑（第二轮实测：路径不对，整个评测在最后一步报错退出）
    const readOld = async (name) => {
      if (!arg(name)) return null;
      try { return JSON.parse(await fs.readFile(arg(name), 'utf8')); }
      catch (error) { console.error(`读不到 --${name} 指定的报告（${error.code || error.message}），这次不做逐题对比`); return null; }
    };
    const previous = await readOld('previous');
    const baseline = await readOld('baseline');
    // 记下对比用的报告路径：评审完 joint-judge.mjs 会按评审结果重算对比（第二轮实测：评审前算的对比全是“变差”）
    report.compareWith = { previous: previous ? arg('previous') : null, baseline: baseline ? arg('baseline') : null };
    if (previous || baseline) report.comparison = compareRounds(report.results, previous, baseline);
    await save();
  }
  console.log(`私有报告（含回答原文）：${destination}`);
  console.log('下一步：node evals/joint-judge.mjs 报告路径   （自动评审，要在服务器上运行）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.code === 'EVAL_CONFIG' ? error.message : `评测没跑完（${String(error.code || error.message).slice(0, 120)}）；私有报告里有已完成的部分。`);
    process.exitCode = 1;
  });
}
