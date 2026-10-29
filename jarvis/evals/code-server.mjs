/** 一次真实模型自主修错：只读生产模型配置，独立store/worktree；无推送入口，不提供隐藏答案。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createCodeRepos } from '../server/codeRepos.mjs';
import { createCodeSandbox } from '../server/codeSandbox.mjs';
import { createGitRunner } from '../server/codeGit.mjs';
import { localCodeDocker } from '../server/codeDocker.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { DEFAULT_CONFIG, createAdapter } from '../src/llm/config.js';
import { routeFor } from '../src/llm/router.js';
import * as sessions from '../src/agent/sessions.js';
import { seedBuiltins } from '../src/agent/skillPacks.js';
import { validateLiveConfig } from './baseline.mjs';
import { codeAcceptance } from './code-server-acceptance.mjs';

const REPOSITORY = 'xunova1121/weiyang-code-sandbox';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const invalid = (message) => Object.assign(new Error(message), { code: 'CODE_LIVE_INPUT' });
export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--live')) {
    console.log('仅计划：--live后用服务器当前模型，自主读取公开sandbox、复现失败、只改src业务代码、lint/test。独立目录；不推送、不读samples隐藏答案。');
    return;
  }
  const option = (key, fallback) => args.find((item) => item.startsWith(key + '='))?.slice(key.length + 1) || fallback;
  const production = await fs.realpath(option('--data-dir', '/opt/jarvis/data'));
  const folder = path.resolve(option('--out-dir', '/tmp/weiyang-code-live-' + randomUUID()));
  if (!folder.startsWith('/tmp/') || folder === production || folder.startsWith(production + path.sep)) throw invalid('输出必须是/tmp下独立新目录');
  await fs.mkdir(folder, { mode: 0o700 }); // 已有目录拒绝重用，防止第二次提交测试。
  await fs.chmod(folder, 0o700);
  const report = {
    version: 1,
    repository: REPOSITORY,
    startedAt: new Date().toISOString(),
    codeRevision: process.env.JARVIS_TEST_REVISION || null,
    status: 'starting',
    acceptance: { state: 'not_checked' }
  };
  const save = () => fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await save();
  let runner, task, repos;
  const ctrl = new AbortController();
  const stop = () => {
    ctrl.abort();
    if (task) runner.stop(task.id);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const display = console.log.bind(console),
    savedLog = console.log;
  try {
    const configFile = path.join(production, 'config.json');
    if ((await fs.stat(configFile)).size > 2_000_000) throw invalid('生产配置过大');
    const cfg = {
      ...DEFAULT_CONFIG,
      ...JSON.parse(await fs.readFile(configFile, 'utf8')),
      autoMemory: false,
      codeRepos: { provider: 'github', repository: REPOSITORY, verifiedAt: new Date().toISOString(), token: '', protectDefaultBranch: true }
    };
    const route = routeFor(cfg, 'code');
    report.selected = validateLiveConfig(route.cfg); // 只记录实际代码线路的服务商/型号。
    const prepared = createAdapter(route.cfg);
    if (prepared.problem) throw invalid('编程线路未配置完整，未请求模型；请先在模型界面完成设置');
    const image = process.env.JARVIS_CODE_SANDBOX_IMAGE;
    if (!image) throw invalid('缺JARVIS_CODE_SANDBOX_IMAGE；先配置已安装的Node/npm镜像，未请求模型');
    const ready = await localCodeDocker(['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 5000, signal: ctrl.signal });
    if (ready.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(ready.stdout.trim())) throw invalid('本地Docker镜像不可用；未请求模型');
    report.imageId = ready.stdout.trim();
    const sandbox = createCodeSandbox({ image, baseDir: path.join(folder, 'jobs'), registry: process.env.JARVIS_CODE_NPM_REGISTRY });
    // 先用固定小项目真正验证node/npm/tar及离线安装，避免把只有node的Office镜像交给模型反复尝试。
    const probe = path.join(folder, 'readiness-project');
    await fs.mkdir(probe, { mode: 0o700 });
    await fs.writeFile(
      path.join(probe, 'package.json'),
      JSON.stringify({ name: 'weiyang-code-readiness', version: '1.0.0', scripts: { test: 'node --version' } }),
      { mode: 0o600 }
    );
    report.readiness = await sandbox.run({ root: probe, files: ['package.json'], command: 'test' }, { signal: ctrl.signal });
    if (!report.readiness.ok) throw invalid('隔离镜像的node/npm/tar或离线安装预检未通过；未请求模型');

    const git = createGitRunner();
    const remoteHead = async () => {
      const value = await git(['ls-remote', 'https://github.com/' + REPOSITORY + '.git', 'refs/heads/main'], { signal: ctrl.signal });
      const head = value.stdout.split(/\s/)[0];
      if (!/^[a-f0-9]{40}$/.test(head)) throw invalid('无法核对测试仓库main');
      return head;
    };
    report.remoteBefore = await remoteHead();

    repos = createCodeRepos({ baseDir: path.join(folder, 'repos'), getConfig: async () => cfg, sandbox, editing: true });
    // 不让验收模型读或搜索隐藏答案；基础能力本身的普通项目读取不受此专用验收包装影响。
    const noAnswer = (relative) => {
      if (/^samples(?:\/|$)/i.test(String(relative))) throw invalid('验收禁止读取samples答案');
    };
    const guarded = {
      ...repos,
      read: (id, session, relative, ...rest) => {
        noAnswer(relative);
        return repos.read(id, session, relative, ...rest);
      },
      // 验收只允许按名称定位，内容搜索可能把隐藏答案带回，改用按需code_read。
      search: (id, session, query, mode, execution) => {
        if (mode !== 'name') throw invalid('验收只允许按文件名查找；按需读取README、规则、代码和测试，不读samples');
        return repos.search(id, session, query, mode, execution);
      }
    };
    useBackend(createFileStore(path.join(folder, 'state')));
    await seedBuiltins();
    console.log = () => {}; // 不把任务正文或工具日志打印到终端。
    runner = createTaskRunner({ getConfig: async () => cfg, codeRepos: guarded, makeTools: () => [], projectBaseDir: path.join(folder, 'project-jobs') });
    ctrl.signal.throwIfAborted();
    task = await runner.start({
      text: '请修复已连接GitHub仓库的现有失败测试。先读仓库规则、README、package.json及相关测试，先跑test复现，再定位原因。只修改src业务实现，不改测试、package.json、锁文件或检查规则；改后读回，并运行lint与test。不要读samples目录的答案，不提交、不推送、不合并、不发布。完成后说明实际改动、测试结果和没验证的范围。',
      requestId: 'code_' + randomUUID()
    });
    report.taskId = task.id;
    report.sessionId = task.sessionId;
    const started = Date.now();
    let lastDisplay = 0,
      lastSaved = 0;
    for (;;) {
      const state = runner.get(task.id);
      report.status = state.status;
      report.task = state;
      if (Date.now() - lastSaved >= 5000) {
        report.events = runner.events(task.id);
        await save();
        lastSaved = Date.now();
      }
      if (Date.now() - lastDisplay >= 30000) {
        display(`状态：${state.status}；已用${Math.round((Date.now() - started) / 1000)}秒；事件${state.seq}`);
        lastDisplay = Date.now();
      }
      if (['done', 'error', 'stopped'].includes(state.status)) break;
      if (Date.now() - started > 16 * 60_000) stop();
      if (Date.now() - started > 17 * 60_000) throw invalid('停止尚未确认，不视为验收完成');
      await pause(500);
    }
    await runner.settled();
    report.events = runner.events(task.id);
    report.answer = (await sessions.get(task.sessionId))?.messages.filter((item) => item.role === 'assistant').at(-1)?.content || '';
    report.remoteAfter = await remoteHead();
    const found = await repos.workspaces(task.sessionId);
    if (found.items.length !== 1) throw invalid('验收必须只有一个任务工作副本');
    const current = found.items[0];
    report.workspace = await repos.status(current.workspace_id, task.sessionId);
    report.acceptance = codeAcceptance(report.events, report.workspace.changes, {
      before: report.remoteBefore,
      after: report.remoteAfter,
      head: current.head,
      workspaceId: current.workspace_id
    });
    report.diff = await repos.diff(current.workspace_id, task.sessionId);
    // 独立再测，防止最后一次模型测试后又写文件，却沿用旧的绿色回执。
    report.independentTest = await repos.run(current.workspace_id, task.sessionId, 'test');
    const modelTest = report.acceptance.runs.filter((item) => item.command === 'test').at(-1);
    if (!report.independentTest.ok || report.independentTest.sourceDigest !== modelTest?.sourceDigest) {
      report.acceptance.state = 'failed';
      report.acceptance.failures.push('最终文件独立重测未通过或与模型测试快照不同');
    }
  } catch (error) {
    report.status = task ? 'error' : 'blocked_readiness';
    // 不记录不受控异常正文，模型/服务商错误正文可能包含配置片段。
    report.failure = {
      code: /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'CODE_LIVE_FAILED',
      ...(error.code === 'CODE_LIVE_INPUT' && { message: error.message })
    };
    report.acceptance.state = 'failed';
  } finally {
    repos?.abortAll();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    console.log = savedLog;
    report.endedAt = new Date().toISOString();
    await save();
    display(`实测状态：${report.status}；代码验收：${report.acceptance.state}`);
    display('私有报告：' + path.join(folder, 'report.json'));
    display('报告含代码、日志和回答，不含生产配置；不更新正式服务、不推送仓库。');
  }
  if (report.acceptance.state !== 'passed') process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
