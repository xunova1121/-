/** 原副本只读补验；不启动模型、不改原报告，不把补验伪装成原始一次性成功。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createCodeRepos } from '../server/codeRepos.mjs';
import { createCodeSandbox } from '../server/codeSandbox.mjs';
import { loadCodeLiveConfig, liveInputError, liveFailure } from './code-live-config.mjs';
import { collectCodePostflight } from './code-postflight.mjs';
import { codeRemoteHead } from './code-remote-head.mjs';
import { protectLiveReport, auditLiveFiles, checkRepairCase } from './code-live-checks.mjs';

export async function recheckCodeReport({ originalFile, dataDir, outputDir, image, signal }, dependencies = {}) {
  const originalPath = await fs.realpath(originalFile);
  if (!originalPath.startsWith('/tmp/') || path.basename(originalPath) !== 'report.json') throw liveInputError('只补验/tmp下原始report.json');
  const stat = await fs.stat(originalPath);
  if (!stat.isFile() || stat.size > 8_000_000) throw liveInputError('原报告缺失或超过8MB');
  const bytes = await fs.readFile(originalPath);
  const original = JSON.parse(bytes.toString('utf8'));
  if (original.scenario !== 'repair' || !original.sessionId || original.task?.status !== 'done')
    throw liveInputError('只对已完成模型任务的修错报告补验；错误或停止的模型任务不能补成通过');
  const output = path.resolve(outputDir);
  const production = await fs.realpath(dataDir);
  const parent = await fs.realpath(path.dirname(output));
  if (
    !output.startsWith('/tmp/') ||
    parent !== path.dirname(output) ||
    output === production ||
    output.startsWith(production + path.sep) ||
    output === path.dirname(originalPath) ||
    output.startsWith(path.dirname(originalPath) + path.sep)
  )
    throw liveInputError('补验须使用/tmp下独立新目录');
  await fs.mkdir(output, { mode: 0o700 });
  const { cfg } = await (dependencies.loadConfig || loadCodeLiveConfig)(production);
  const secrets = [cfg.codeRepos.token, ...Object.values(cfg.keys || {}).filter((value) => typeof value === 'string')];
  const report = {
    ...original,
    status: original.task.status,
    acceptance: { state: 'not_checked' },
    supplement: {
      modelRequested: false,
      checkerRevision: process.env.JARVIS_TEST_REVISION || null,
      originalRevision: original.codeRevision,
      originalPath,
      originalSha256: createHash('sha256').update(bytes).digest('hex'),
      originalStatus: original.status,
      originalAcceptance: original.acceptance,
      originalFailure: original.failure || null,
      startedAt: new Date().toISOString()
    }
  };
  // 原始证据只读保留在原文件，新的核验必须重新取得，不能沿用旧绿灯。
  for (const key of ['remoteAfter', 'workspace', 'diff', 'businessPatch', 'independentTest', 'verification', 'fileCredentialAudit', 'failure'])
    delete report[key];
  const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(protectLiveReport(report, secrets), null, 2), { mode: 0o600 });
  const sandbox = dependencies.sandbox || createCodeSandbox({ image, baseDir: path.join(output, 'jobs') });
  const repos =
    dependencies.repos || createCodeRepos({ baseDir: path.join(path.dirname(originalPath), 'repos'), getConfig: async () => cfg, sandbox, editing: true });
  try {
    await save();
    // 与原模型最后一次成功test的digest比较，副本被后来改过时不能借补验换一道题。
    await collectCodePostflight(report, { repos, remoteHead: dependencies.remoteHead || (() => codeRemoteHead(cfg.codeRepos, { signal })), save, signal });
    report.fileCredentialAudit = await auditLiveFiles(path.dirname(originalPath), secrets);
    if ((await fs.readFile(originalPath)).compare(bytes) !== 0) throw liveInputError('原报告在补验期间变化，未覆盖');
    const safe = protectLiveReport(report, secrets);
    report.credentialAudit = safe.credentialAudit;
    report.assessment = checkRepairCase(report);
  } catch (error) {
    report.supplement.failure = liveFailure(error, { modelRequested: true });
    report.assessment = { state: 'incomplete', failures: [], missing: ['补验未完成，详见supplement.failure'] };
    if (signal?.aborted || error.name === 'AbortError' || error.code === 'RETRIEVAL_BUDGET') throw error;
  } finally {
    repos.abortAll?.();
    report.supplement.endedAt = new Date().toISOString();
    await save();
  }
  return protectLiveReport(report, secrets);
}

export async function main(args = process.argv.slice(2)) {
  const option = (key, fallback) => args.find((value) => value.startsWith(key + '='))?.slice(key.length + 1) || fallback;
  if (!args.includes('--live')) {
    console.log('补验原工作副本：不调用模型，不覆盖原报告；须提供--live和--report=原报告路径。');
    return;
  }
  const outputDir = option('--out-dir', '/tmp/weiyang-code-recheck-' + Date.now());
  const controller = new AbortController();
  const stop = () => controller.abort(new DOMException('补验已停止', 'AbortError'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let report;
  try {
    report = await recheckCodeReport({
      originalFile: option('--report', ''),
      dataDir: option('--data-dir', '/opt/jarvis/data'),
      outputDir,
      image: process.env.JARVIS_CODE_SANDBOX_IMAGE,
      signal: controller.signal
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  console.log('补验结果：' + report.assessment.state + '；没有新增模型请求；原始整批报告未修改');
  console.log('私有补验报告：' + path.join(outputDir, 'report.json'));
  if (report.assessment.state !== 'passed') process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
