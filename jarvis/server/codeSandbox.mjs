import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { allowedCodePath, readCodeFile } from './codeRepoFiles.mjs';
import { codeError, redactCode } from './codeGit.mjs';
import { dependencyPlan, downloadDependencies } from './codeDependencies.mjs';
import { codeContainer, localCodeDocker } from './codeDocker.mjs';
const WORKER = fileURLToPath(new URL('./codeSandboxWorker.mjs', import.meta.url));

async function copySource(root, names, source, token, signal) {
  const selected = [...new Set(names)].filter((name) => allowedCodePath(name) && !name.split('/').includes('node_modules'));
  if (!selected.length || selected.length > 1000) throw codeError('CODE_PROJECT_LIMIT', '项目为空或超过1000文件，本期未执行');
  const hash = createHash('sha256');
  let bytes = 0;
  await fs.mkdir(source, { mode: 0o755 });
  await fs.chmod(source, 0o755);
  for (const relative of selected.sort()) {
    signal.throwIfAborted();
    const file = await readCodeFile(root, relative, token, { asAsset: true });
    if (file.redacted) throw codeError('CODE_SECRET', '代码文件含凭据，未把该文件送进执行容器');
    bytes += file.bytes;
    if (bytes > 16_000_000) throw codeError('CODE_PROJECT_LIMIT', '项目内容超过16MB，本期未执行');
    hash.update(relative + '\0' + file.sha256 + '\0');
    const target = path.join(source, relative);
    let parent = source;
    for (const part of relative.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      await fs.mkdir(parent, { recursive: true, mode: 0o755 });
      await fs.chmod(parent, 0o755);
    }
    await fs.writeFile(target, file.data, { mode: 0o644, flag: 'wx' });
    await fs.chmod(target, file.executable ? 0o755 : 0o644);
  }
  return { files: selected.length, bytes, sourceDigest: hash.digest('hex') };
}
async function jsonFile(file, required = true) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > 1_000_000) throw new Error('too big');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw codeError('CODE_PACKAGE', '项目package.json或package-lock.json缺失、过大或格式无效');
  }
}
/** 两阶段均断网；联网仅由允许npm源的有界下载器完成，容器不见宿主凭据或.git。 */
export function createCodeSandbox({
  image = '',
  registry = 'https://registry.npmmirror.com',
  baseDir = path.join(os.tmpdir(), 'jarvis-code-jobs'),
  runDocker = localCodeDocker,
  fetchImpl = globalThis.fetch,
  timeoutMs = 130000,
  cleanupTimeoutMs = 10000
} = {}) {
  let quarantined = false;
  let reserving = Promise.resolve();
  const reserve = () => {
    const pending = reserving.then(async () => {
      const base = path.resolve(baseDir);
      if (/[,\r\n]/.test(base)) throw codeError('CODE_SANDBOX_PATH', '隔离临时目录路径不能含逗号或换行');
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(base)) !== base) throw codeError('CODE_SANDBOX_PATH', '隔离临时目录不能是符号链接');
      await fs.chmod(base, 0o700);
      if ((await fs.readdir(base)).filter((value) => value.startsWith('job-')).length >= 2)
        throw codeError('CODE_JOB_CAPACITY', '已有两个隔离作业或残留副本，请先核查，不自动删除');
      return fs.mkdtemp(path.join(base, 'job-'));
    });
    reserving = pending.catch(() => {});
    return pending;
  };
  return {
    configured: Boolean(image),
    async run({ root, files, command, token = '' }, execution = {}) {
      execution.signal?.throwIfAborted();
      if (quarantined) throw codeError('CODE_SANDBOX_UNAVAILABLE', '上次容器清理未确认，已暂停代码执行，请管理员核查后重启服务');
      if (!['lint', 'test'].includes(command)) throw codeError('CODE_COMMAND', '本期只运行package.json中的lint或test，不接受任意shell命令');
      if (!image || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,240}$/.test(image))
        throw codeError('CODE_SANDBOX_UNAVAILABLE', '管理员尚未配置JARVIS_CODE_SANDBOX_IMAGE；未在宿主机运行代码');
      const deadline = AbortSignal.timeout(Math.max(1, Math.min(130000, timeoutMs)));
      const signal = execution.signal ? AbortSignal.any([execution.signal, deadline]) : deadline;
      let directory,
        preserve = false;
      try {
        const inspect = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image], { signal, timeout: 5000 });
        if (inspect.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspect.stdout.trim()))
          throw codeError('CODE_SANDBOX_UNAVAILABLE', 'Docker或本地隔离镜像不可用，请管理员配置；没有降级到宿主机执行');
        directory = await reserve();
        const source = path.join(directory, 'source'),
          packages = path.join(directory, 'packages'),
          output = path.join(directory, 'output');
        const worker = path.join(directory, 'runner.mjs');
        await fs.copyFile(WORKER, worker);
        await fs.chmod(worker, 0o644);
        const snapshot = await copySource(root, files, source, token, signal);
        const pkg = await jsonFile(path.join(source, 'package.json'));
        if (typeof pkg.scripts?.[command] !== 'string' || !pkg.scripts[command].trim() || pkg.scripts[command].length > 4000)
          throw codeError('CODE_SCRIPT', 'package.json没有有效的' + command + '脚本，未伪装成测试通过');
        const lock = await jsonFile(path.join(source, 'package-lock.json'), false);
        const plan = dependencyPlan(pkg, lock, registry);
        execution.progress?.('正在核对锁文件和允许的npm依赖源…');
        const dependencies = await downloadDependencies(plan, packages, { signal, retrieval: execution.retrieval, fetchImpl });
        await fs.mkdir(output, { mode: 0o777 });
        await fs.chmod(output, 0o777);
        const options = { image, source, worker, signal, runDocker, command, progress: execution.progress, cleanupTimeoutMs };
        const install = await codeContainer({ ...options, packages, output });
        const base = {
          command,
          ...snapshot,
          dependencies: { ...dependencies, syntheticLock: !lock },
          imageId: inspect.stdout.trim(),
          isolation: 'docker_offline_snapshot',
          hostWorktreeWritable: false
        };
        const safe = (value) => ({ ...value, stdout: redactCode(value.stdout, token), stderr: redactCode(value.stderr, token) });
        if (install.exitCode !== 0) return { ...base, stage: 'install', ok: false, ...safe(install) };
        const archive = path.join(output, 'deps.tar'),
          stat = await fs.lstat(archive);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000_000)
          throw codeError('CODE_DEP_LIMIT', '依赖归档超过128MB或不是普通文件，未执行项目');
        const result = await codeContainer({ ...options, archive });
        return { ...base, install: { exitCode: 0 }, stage: command, ok: result.exitCode === 0, ...safe(result) };
      } catch (error) {
        if (error.code === 'CODE_SANDBOX_CLEANUP') {
          preserve = true;
          quarantined = true;
          throw error;
        }
        if (execution.signal?.aborted) throw execution.signal.reason;
        if (deadline.aborted) throw codeError('CODE_RUN_TIMEOUT', '代码验证达到本轮130秒上限，已停止', { kind: 'timeout' });
        throw error;
      } finally {
        if (directory && !preserve) await fs.rm(directory, { recursive: true, force: true });
      }
    }
  };
}
