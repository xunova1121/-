import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { codeError } from './codeGit.mjs';
const execute = promisify(execFile);
export async function localCodeDocker(args, { signal, timeout = 70000 } = {}) {
  try {
    const value = await execute('docker', ['--host=unix:///var/run/docker.sock', ...args], {
      signal,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 128000,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.DOCKER_CONFIG && { DOCKER_CONFIG: process.env.DOCKER_CONFIG }) }
    });
    return { ...value, exitCode: 0 };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (typeof error.code === 'number') return { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: error.code };
    throw codeError(
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'CODE_RUN_OUTPUT' : error.killed ? 'CODE_RUN_TIMEOUT' : 'CODE_DOCKER_UNAVAILABLE',
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? '测试输出超过128KB，容器将停止' : error.killed ? '隔离执行超时' : 'Docker不可用，未在宿主机执行项目',
      { kind: error.killed ? 'timeout' : 'api' }
    );
  }
}
export async function removeCodeContainer(name, runDocker, timeoutMs) {
  const end = Date.now() + Math.max(1, Math.min(10000, timeoutMs));
  // rm与--rm可能相遇“正在删除”；只有ps确认消失才算清理完成。
  try {
    await runDocker(['rm', '--force', name], { timeout: Math.min(5000, timeoutMs) });
  } catch {
    /* 接着做有界的独立状态核对，不把rm报错当作已消失。 */
  }
  for (;;) {
    const left = await runDocker(['ps', '--all', '--quiet', '--filter', 'name=^/' + name + '$'], { timeout: Math.max(1, Math.min(1000, end - Date.now())) });
    if (left.exitCode === 0 && !left.stdout.trim()) return;
    if (left.exitCode !== 0 || Date.now() >= end) throw codeError('CODE_SANDBOX_CLEANUP', '不能确认隔离容器已消失');
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, end - Date.now())));
  }
}
export async function codeContainer({
  image,
  source,
  worker,
  packages,
  output,
  archive,
  command,
  signal,
  runDocker = localCodeDocker,
  progress,
  cleanupTimeoutMs = 10000
}) {
  const name = 'jarvis-repo-' + randomUUID();
  const mount = (src, dst, ro = true) => ['--mount', `type=bind,src=${src},dst=${dst}${ro ? ',readonly' : ''}`];
  const args = [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=96',
    '--memory=768m',
    '--cpus=1',
    '--user=65534:65534',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=128m',
    '--tmpfs=/work:rw,nosuid,size=256m,uid=65534,gid=65534',
    '--workdir=/work'
  ];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy'])
    args.push('--env', key + '=');
  args.push(...mount(source, '/source'), ...mount(worker, '/runner.mjs'));
  if (packages) args.push(...mount(packages, '/packages'), ...mount(output, '/output', false));
  else args.push(...mount(archive, '/deps.tar'));
  args.push('--entrypoint=timeout', image, '--signal=KILL', '60s', 'node', '/runner.mjs', packages ? 'install' : 'run', command);
  let result, failure;
  try {
    progress?.(packages ? '正在离线安装锁定依赖（不执行安装脚本）…' : `正在断网运行${command}…`);
    result = await runDocker(args, { signal, timeout: 65000 });
  } catch (error) {
    failure = error;
  } finally {
    // 无论成功/失败/停止均确认容器消失，再清理临时目录。容器内部还有60秒独立寿命上限。
    try {
      await removeCodeContainer(name, runDocker, cleanupTimeoutMs);
    } catch {
      failure = codeError('CODE_SANDBOX_CLEANUP', '未确认隔离容器清理，请管理员核查：' + name);
    }
  }
  if (failure) throw failure;
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-12000),
    stderr: result.stderr.slice(-4000),
    truncated: result.stdout.length > 12000 || result.stderr.length > 4000
  };
}
