import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as workspace from '../src/agent/workspace.js';

const execute = promisify(execFile);
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_PROJECT_INPUT', name: 'ValidationError' });
const stopped = (signal) => {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('已停止代码验证'), { name: 'AbortError' });
};
function relative(value) {
  const text = String(value ?? '');
  if (
    !text ||
    text.length > 300 ||
    text.includes('\\') ||
    text.includes(':') ||
    text.startsWith('/') ||
    text.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw invalid('只允许项目内相对路径');
  return text;
}
async function docker(args, { signal, timeout = 25000 } = {}) {
  return execute('docker', args, {
    signal,
    timeout,
    maxBuffer: 64000,
    windowsHide: true,
    env: { PATH: process.env.PATH, ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) }
  });
}

/** 只运行管理员配置、含node与coreutils timeout的本地镜像。容器PID1限制22秒生命周期，应用崩溃也不会留下无限运行的任务。没有Docker或镜像就明确不可用，不降级到宿主机执行。 */
export async function runProject(
  { root, tests, entry, mode = 'test' },
  { image, signal, runDocker = docker, list = workspace.list, read = workspace.readBlob } = {}
) {
  root = relative(root);
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,240}$/.test(image))
    throw Object.assign(new Error('服务器尚未配置隔离代码镜像，不能在宿主机直接执行'), { code: 'SANDBOX_UNAVAILABLE', kind: 'api' });
  if (!['test', 'run'].includes(mode)) throw invalid('仅支持test或run');
  const selected = mode === 'test' ? tests : [entry];
  if (!Array.isArray(selected) || !selected.length || selected.length > 16) throw invalid('需要1至16个入口文件');
  const entries = selected.map(relative);
  if (entries.some((file) => !/\.(?:mjs|cjs|js)$/.test(file))) throw invalid('当前隔离器只支持JavaScript项目入口');
  stopped(signal);
  try {
    await runDocker(['image', 'inspect', image], { signal, timeout: 5000 });
  } catch (error) {
    stopped(signal);
    throw Object.assign(new Error('Docker或指定本地镜像不可用，请由服务器管理员配置；未执行宿主机代码'), {
      code: 'SANDBOX_UNAVAILABLE',
      kind: 'api',
      cause: error
    });
  }
  const files = (await list()).filter((file) => file.path.startsWith(root + '/'));
  if (!files.length || files.length > 40 || files.reduce((sum, file) => sum + (Number(file.size) || 0), 0) > 2 * 1024 * 1024)
    throw invalid('项目为空或超过40文件/2MB的隔离验证上限');
  if (entries.some((file) => !files.some((item) => item.path === root + '/' + file))) throw invalid('测试或运行入口不在项目中');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-project-'));
  const container = 'jarvis-code-' + randomUUID();
  let started = false;
  let output;
  let failure;
  try {
    await fs.chmod(directory, 0o755);
    let bytes = 0;
    for (const file of files) {
      stopped(signal);
      const local = relative(file.path.slice(root.length + 1));
      const data = new Uint8Array(await (await read(file.path)).arrayBuffer());
      bytes += data.byteLength;
      if (bytes > 2 * 1024 * 1024) throw invalid('项目实际内容超过2MB');
      const target = path.join(directory, ...local.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.writeFile(target, data, { mode: 0o644, flag: 'wx' });
    }
    stopped(signal);
    started = true;
    output = await runDocker(
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        container,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=64',
        '--memory=256m',
        '--cpus=1',
        '--user=65534:65534',
        '--tmpfs=/tmp:rw,noexec,nosuid,size=32m',
        '--mount',
        'type=bind,src=' + directory + ',dst=/workspace,readonly',
        '--workdir=/workspace',
        image,
        'timeout',
        '--signal=KILL',
        '22s',
        'node',
        ...(mode === 'test' ? ['--test'] : []),
        ...entries.map((file) => '/workspace/' + file)
      ],
      { signal, timeout: 20000 }
    );
  } catch (error) {
    failure = error;
  } finally {
    if (started && failure) {
      try {
        await runDocker(['rm', '-f', container], { timeout: 5000 });
      } catch (error) {
        // 未确认清理时不能宣称成功，保留随机容器名供管理员核查。
        failure ??= Object.assign(new Error('隔离容器清理未确认：' + container), { code: 'SANDBOX_CLEANUP_FAILED', kind: 'api', cause: error });
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  stopped(signal);
  if (failure)
    throw Object.assign(new Error('隔离代码验证失败：' + String(failure.stderr || failure.message).slice(0, 4000)), {
      code: failure.code === 'SANDBOX_CLEANUP_FAILED' ? failure.code : 'PROJECT_TEST_FAILED',
      kind: failure.killed ? 'timeout' : 'api',
      cause: failure
    });
  return {
    root,
    mode,
    entries,
    files: files.length,
    exitCode: 0,
    stdout: String(output.stdout || '').slice(0, 32000),
    stderr: String(output.stderr || '').slice(0, 8000),
    isolation: 'docker_network_none_readonly',
    note: '只验证给定入口；未安装第三方依赖，也不等于所有需求均通过'
  };
}

export function projectExecutionTool({ image } = {}) {
  if (!image) return null;
  return {
    name: 'run_project_tests',
    description: '在无网络、只读项目副本和资源受限Docker中执行工作区多文件JS项目测试；不在宿主机执行，不安装依赖。需管理员预先配置镜像。',
    input_schema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        mode: { type: 'string', enum: ['test', 'run'] },
        tests: { type: 'array', items: { type: 'string' }, maxItems: 16 },
        entry: { type: 'string' }
      },
      required: ['root'],
      additionalProperties: false
    },
    run: async (args, { signal } = {}) => JSON.stringify(await runProject(args, { image, signal }))
  };
}
