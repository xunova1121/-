import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localCodeDocker, removeCodeContainer } from './codeDocker.mjs';
import { readinessItem } from '../shared/capabilityReadiness.js';
const execute = promisify(execFile);
const imageName = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,240}$/.test(value);

async function sandboxProbe(image, runDocker) {
  const name = 'jarvis-readiness-' + randomUUID();
  let result = 'sandbox_failed';
  try {
    const output = await runDocker(
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=64',
        '--memory=192m',
        '--cpus=0.5',
        '--user=65534:65534',
        '--entrypoint=sh',
        image,
        '-c',
        'node --version && npm --version && timeout --signal=KILL 2s node --version'
      ],
      { timeout: 8000 }
    );
    const nodeMajor = Number(String(output.stdout || '').match(/^v(\d+)\./m)?.[1]);
    if (output.exitCode === 0 && nodeMajor >= 22) result = 'sandbox_ready';
  } catch {
    /* 不回显Docker输出或宿主环境；后续独立确认清理。 */
  }
  try {
    await removeCodeContainer(name, runDocker, 4000);
  } catch {
    result = 'cleanup_failed';
  }
  return result;
}

/** 仅执行固定环境命令；最多两份30秒缓存，合并并发请求，不调用模型、不拉镜像。 */
export function createRuntimeReadiness({ appDir, scope = 'server', env = process.env, run = execute, runDocker = localCodeDocker, now = Date.now } = {}) {
  const memo = new Map(),
    pending = new Map();
  async function command(id, file, args, font = false) {
    try {
      const r = await run(file, args, { timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 12000, encoding: 'utf8' });
      if (r.code !== undefined && r.code !== 0) return readinessItem(id, 'command_missing');
      const hasChinese = /(?:^|[|\s])zh(?:-[a-z]+)?(?:$|[|\s])/i.test(r.stdout || '');
      return readinessItem(id, font ? (hasChinese ? 'font_ready' : 'font_missing') : 'executable');
    } catch {
      return readinessItem(id, 'command_missing');
    }
  }
  async function image(id, value, probeRuntime) {
    if (scope !== 'server') return readinessItem(id, 'server_only');
    if (!imageName(value)) return readinessItem(id, 'missing');
    try {
      const r = await runDocker(['image', 'inspect', '--format', '{{.Id}}', value], { timeout: 3000 });
      if (r.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(String(r.stdout || '').trim())) return readinessItem(id, 'image_missing');
      return readinessItem(id, id === 'sandbox' && probeRuntime ? await sandboxProbe(value, runDocker) : 'image_present');
    } catch {
      return readinessItem(id, 'image_missing');
    }
  }
  async function collect(probeRuntime) {
    const checks = [];
    // 每批最多三个子进程，避免自检把正在执行的任务挤住。
    const tasks = [
      () => command('office', env.JARVIS_SOFFICE || 'soffice', ['--version']),
      () => command('pdf', 'pdftoppm', ['-v']),
      () => command('fonts', 'fc-list', [':lang=zh', '-f', 'zh\n'], true),
      () => command('ffmpeg', 'ffmpeg', ['-version']),
      () => command('git', 'git', ['--version']),
      () => image('sandbox', env.JARVIS_CODE_SANDBOX_IMAGE, probeRuntime),
      () => image('browser', env.JARVIS_CODE_BROWSER_IMAGE, false),
      () => image('skills', env.JARVIS_SKILL_RUNNER_IMAGE || 'jarvis-skill-runner:latest', false)
    ];
    for (let index = 0; index < tasks.length; index += 3) checks.push(...(await Promise.all(tasks.slice(index, index + 3).map((task) => task()))));
    let version = 'development';
    try {
      const text = (await readFile(path.join(appDir, 'VERSION'), 'utf8')).trim();
      if (/^\d+\.\d+\.\d+$/.test(text)) version = text;
    } catch {
      /* 源码环境没有VERSION，不猜测发布版本。 */
    }
    return { checkedAt: now(), version, checks };
  }
  return {
    async check({ probeRuntime = false } = {}) {
      const mode = Boolean(probeRuntime);
      const saved = memo.get(mode);
      if (saved && now() - saved.checkedAt >= 0 && now() - saved.checkedAt < 30000) return structuredClone(saved);
      if (!pending.has(mode))
        pending.set(
          mode,
          collect(mode)
            .then((result) => {
              memo.set(mode, result);
              return result;
            })
            .finally(() => pending.delete(mode))
        );
      return structuredClone(await pending.get(mode));
    }
  };
}
