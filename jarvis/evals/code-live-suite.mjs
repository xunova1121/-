/** 三轮真实模型串行验收。假回执只用于守护测试，不作为真实模型证据。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as runCase } from './code-server.mjs';
import { loadCodeLiveConfig, liveInputError, liveFailure } from './code-live-config.mjs';
import { checkRepairCase, invalidTokenProbe, offlineProbe } from './code-live-checks.mjs';

export function suiteVerdict(cases) {
  const repairs = cases.filter((item) => /^repair-[123]$/.test(item.id));
  const counters = ['delete-tests', 'invalid-token', 'offline'];
  if (repairs.length !== 3 || new Set(repairs.map((item) => item.id)).size !== 3 || counters.some((id) => !cases.some((item) => item.id === id)))
    return 'incomplete';
  if (cases.some((item) => item.state === 'failed' || item.state === 'blocked_readiness')) return 'failed';
  if (cases.some((item) => item.state === 'incomplete')) return 'incomplete';
  if (cases.some((item) => item.state !== 'passed')) return 'not_reviewed';
  return 'passed';
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  if (!args.includes('--live')) {
    console.log('计划：先确认Sol和GitHub/Docker，再串行三次独立红绿；删测试真模型一次、无效令牌真实HTTP一次、零依赖离线Docker一次。无推送/发布。');
    return;
  }
  const option = (key, fallback) => args.find((item) => item.startsWith(key + '='))?.slice(key.length + 1) || fallback;
  const folder = path.resolve(option('--out-dir', '/tmp/weiyang-code-suite-' + Date.now()));
  const parent = await fs.realpath(path.dirname(folder));
  if (!folder.startsWith('/tmp/') || parent !== path.dirname(folder)) throw liveInputError('汇总输出必须在/tmp真实目录内');
  const production = path.resolve(option('--data-dir', '/opt/jarvis/data'));
  const realProduction = await fs.realpath(production).catch((error) => {
    if (error.code === 'ENOENT') return production;
    throw error;
  });
  if (folder === realProduction || folder.startsWith(realProduction + path.sep)) throw liveInputError('汇总目录不能写入正式数据');
  await fs.mkdir(folder, { mode: 0o700 });
  const summary = { version: 1, codeRevision: process.env.JARVIS_TEST_REVISION || null, startedAt: new Date().toISOString(), state: 'running', cases: [] };
  const save = () => fs.writeFile(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  const execute = dependencies.runCase || runCase;
  const previousExit = process.exitCode;
  try {
    const { selected } = await (dependencies.loadConfig || loadCodeLiveConfig)(production);
    summary.selected = selected;
    const expectedModel = option('--expect-model', 'sol');
    if (!selected.model.toLowerCase().includes(expectedModel.toLowerCase()))
      throw liveInputError('本批需要Sol；服务器当前编程线路不符，请自己在模型界面选好，不要发送Key');
    await save();
    for (let round = 1; round <= 3; round++) {
      console.log(`开始真实模型修错 ${round}/3（独立工作副本）`);
      const relative = 'repair-' + round;
      const report = await execute(['--live', '--data-dir=' + production, '--out-dir=' + path.join(folder, relative), '--expect-model=' + expectedModel]);
      const assessment = checkRepairCase(report);
      if (round === 1) summary.remoteBaseline = report.remoteBefore;
      if (!report.remoteBefore || !report.remoteAfter || !summary.remoteBaseline) {
        assessment.missing = [...(assessment.missing || []), '三轮远端main基线尚未完整核验'];
        if (assessment.state !== 'failed') assessment.state = 'incomplete';
      } else if (report.remoteBefore !== summary.remoteBaseline || report.remoteAfter !== summary.remoteBaseline) {
        assessment.state = 'failed';
        assessment.failures.push('三轮之间远端main基线不一致，不能算同题连续通过');
      }
      summary.cases.push({
        id: relative,
        ...assessment,
        status: report.status,
        report: relative + '/report.json',
        startedAt: report.startedAt,
        endedAt: report.endedAt
      });
      await save();
      // 第一轮环境没准备好则立即停止，不再空耗三轮或改线上配置。
      if (report.status === 'blocked_readiness') throw liveInputError('本轮环境预检未通过，详见' + relative + '/report.json；未继续请求模型');
      if (report.status === 'stopped') throw liveInputError('任务已停止，整批不再发起下一轮模型请求');
    }
    const deletion = await execute([
      '--live',
      '--scenario=delete-tests',
      '--data-dir=' + production,
      '--out-dir=' + path.join(folder, 'delete-tests'),
      '--expect-model=' + expectedModel
    ]);
    summary.cases.push({ id: 'delete-tests', ...deletion.acceptance, report: 'delete-tests/report.json' });
    await save();
    if (deletion.status === 'stopped') throw liveInputError('反例任务已停止，整批不再执行后续操作');
    const token = await (dependencies.invalidTokenProbe || invalidTokenProbe)();
    summary.cases.push({ id: 'invalid-token', ...token });
    await save();
    const offline = await (dependencies.offlineProbe || offlineProbe)(folder, process.env.JARVIS_CODE_SANDBOX_IMAGE);
    await fs.writeFile(path.join(folder, 'offline.json'), JSON.stringify(offline, null, 2), { mode: 0o600 });
    summary.cases.push({ id: 'offline', state: offline.state, report: 'offline.json', scope: offline.scope });
    summary.state = suiteVerdict(summary.cases);
  } catch (error) {
    summary.state = summary.cases.length ? 'incomplete' : 'blocked_readiness';
    summary.failure = liveFailure(error);
  } finally {
    summary.endedAt = new Date().toISOString();
    await save();
    process.exitCode = summary.state === 'passed' ? previousExit : 1;
    console.log(`整批状态：${summary.state}；私有汇总：${path.join(folder, 'summary.json')}`);
    if (summary.failure?.message) console.log(summary.failure.message);
    console.log('删测试反例的回答须人工复核，not_reviewed不代表通过；正式服务未更新。');
  }
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
