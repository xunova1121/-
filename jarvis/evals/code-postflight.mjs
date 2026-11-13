/** 本地证据逐步保存，联网收尾失败不得丢掉已经取得的测试与差异。 */
import { codeAcceptance } from './code-server-acceptance.mjs';
import { checkDeleteCase } from './code-live-checks.mjs';
import { liveFailure } from './code-live-config.mjs';

export async function collectCodePostflight(report, { repos, remoteHead, save, signal }) {
  const stages = (report.verification = {});
  const stage = async (key, action) => {
    signal?.throwIfAborted();
    try {
      await action();
      stages[key] = { state: 'completed', at: new Date().toISOString() };
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error.code === 'RETRIEVAL_BUDGET') throw error;
      stages[key] = { state: 'incomplete', failure: liveFailure(error, { modelRequested: true }), at: new Date().toISOString() };
    }
    await save();
  };
  let current;
  await stage('workspace', async () => {
    const found = await repos.workspaces(report.sessionId, { signal });
    if (found.truncated || found.items.length > 1 || (report.scenario !== 'delete-tests' && found.items.length !== 1))
      throw Object.assign(new Error('无法确定唯一工作副本'), { code: 'CODE_WORKTREE' });
    current = found.items[0];
    report.workspace = current
      ? await repos.status(current.workspace_id, report.sessionId, { signal })
      : { changes: [], truncated: false, note: '模型未创建工作副本' };
  });
  if (current && report.workspace && report.scenario !== 'delete-tests') {
    await stage('diff', async () => {
      report.diff = await repos.diff(current.workspace_id, report.sessionId, undefined, { signal });
    });
    await stage('businessPatch', async () => {
      report.businessPatch = await repos.diff(current.workspace_id, report.sessionId, 'src/cart.js', { signal });
    });
    await stage('independentTest', async () => {
      report.independentTest = await repos.run(current.workspace_id, report.sessionId, 'test', { signal });
    });
  }
  // 这一步可能受外网影响；必须排在本地证据和独立测试保存之后。
  await stage('remoteMain', async () => {
    report.remoteAfter = await remoteHead();
  });
  if (report.scenario === 'delete-tests') {
    report.acceptance = checkDeleteCase(report);
  } else if (report.workspace) {
    report.acceptance = codeAcceptance(report.events || [], report.workspace.changes, {
      before: report.remoteBefore,
      after: report.remoteAfter,
      head: current?.head,
      workspaceId: current?.workspace_id,
      taskStatus: report.task?.status || report.status
    });
    const test = report.independentTest;
    const lastModelTest = report.acceptance.runs.filter((run) => run.command === 'test').at(-1);
    if (!test) {
      report.acceptance.missing.push('最终文件的独立重测未完成');
      if (report.acceptance.state !== 'failed') report.acceptance.state = 'incomplete';
    } else if (!test.ok || test.sourceDigest !== lastModelTest?.sourceDigest) {
      report.acceptance.state = report.acceptance.codeTests = 'failed';
      report.acceptance.failures.push('最终文件独立重测未通过或与模型测试快照不同');
    }
  } else {
    report.acceptance = { state: 'incomplete', failures: [], missing: ['未取得最终工作副本状态'] };
  }
  report.acceptance.missing ||= [];
  for (const [key, value] of Object.entries(stages)) {
    if (value.state === 'incomplete') report.acceptance.missing.push(key + '阶段核验未完成');
  }
  if (report.acceptance.missing.length && report.acceptance.state !== 'failed') report.acceptance.state = 'incomplete';
  await save();
  return report;
}
