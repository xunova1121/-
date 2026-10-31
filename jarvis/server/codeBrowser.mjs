import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { codeError } from './codeGit.mjs';
import { copyCodeSource } from './codeSandbox.mjs';
import { localCodeDocker, removeCodeContainer } from './codeDocker.mjs';
const worker = fileURLToPath(new URL('./codeBrowserWorker.mjs', import.meta.url));
export function browserRequest(value = {}) {
  const entry = String(value.entry || 'index.html');
  if (!/^[\p{L}\p{N}_./ -]+\.html$/u.test(entry) || entry.startsWith('/') || entry.split('/').some((p) => p === '..' || p === '.' || !p))
    throw codeError('CODE_BROWSER_INPUT', '需要工作副本内的HTML相对路径');
  const width = Number(value.width || 390),
    height = Number(value.height || 844);
  if (!Number.isInteger(width) || width < 320 || width > 1920 || !Number.isInteger(height) || height < 480 || height > 1080)
    throw codeError('CODE_BROWSER_INPUT', '浏览器尺寸需要320–1920×480–1080');
  const steps = value.steps || [];
  if (!Array.isArray(steps) || steps.length > 40) throw codeError('CODE_BROWSER_INPUT', '每轮最多40个浏览器操作');
  for (const s of steps) {
    if (!s || !['click', 'fill', 'press', 'assert', 'reload', 'wait', 'scroll'].includes(s.action) || JSON.stringify(s).length > 3000)
      throw codeError('CODE_BROWSER_INPUT', '浏览器操作格式无效');
    if (['click', 'fill', 'assert'].includes(s.action) && (typeof s.selector !== 'string' || !s.selector || s.selector.length > 300))
      throw codeError('CODE_BROWSER_INPUT', '浏览器操作需要有效CSS选择器');
    if (s.action === 'assert' && !['text', 'value', 'count', 'visible', 'focused', 'disabled', 'scrollY'].includes(s.property || 'text'))
      throw codeError('CODE_BROWSER_INPUT', '不支持的页面断言');
  }
  return { entry, width, height, steps };
}
/** 快照只读、断网容器、最多两作业，截图与回执单独交付。 */
export function createCodeBrowser({ image = '', baseDir, runDocker = localCodeDocker } = {}) {
  let active = 0,
    quarantined = false;
  return {
    configured: Boolean(image),
    async run({ root, files, token = '', ...value }, execution = {}) {
      const input = browserRequest(value);
      if (!image || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,240}$/.test(image))
        throw codeError('CODE_BROWSER_UNAVAILABLE', '网页检查需要管理员配置JARVIS_CODE_BROWSER_IMAGE（Node22和Chromium）；尚未运行浏览器');
      if (active >= 2 || quarantined) throw codeError('CODE_BROWSER_BUSY', '浏览器作业正忙或上次清理未确认');
      active++;
      let directory,
        preserve = false,
        started = false;
      const signal = execution.signal ? AbortSignal.any([execution.signal, AbortSignal.timeout(100000)]) : AbortSignal.timeout(100000);
      const name = 'jarvis-browser-' + randomUUID();
      try {
        const inspect = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image], { signal, timeout: 5000 });
        if (inspect.exitCode || !/^sha256:[a-f0-9]{64}$/.test(inspect.stdout.trim()))
          throw codeError('CODE_BROWSER_UNAVAILABLE', '未找到本地网页检查镜像；尚未运行浏览器');
        await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
        if ((await fs.realpath(baseDir)) !== path.resolve(baseDir)) throw codeError('CODE_BROWSER_PATH', '浏览器作业目录不能是符号链接');
        directory = await fs.mkdtemp(path.join(baseDir, 'job-'));
        const source = path.join(directory, 'source'),
          output = path.join(directory, 'output'),
          runner = path.join(directory, 'runner.mjs'),
          request = path.join(directory, 'request.json');
        const snapshot = await copyCodeSource(root, files, source, token, signal);
        if (!(await fs.stat(path.join(source, input.entry)).catch(() => null))?.isFile()) throw codeError('CODE_BROWSER_INPUT', '工作副本中没有指定HTML入口');
        await fs.copyFile(worker, runner);
        await fs.chmod(runner, 0o644);
        await fs.writeFile(request, JSON.stringify(input), { mode: 0o644 });
        await fs.chmod(request, 0o644);
        await fs.mkdir(output, { mode: 0o777 });
        await fs.chmod(output, 0o777);
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
          '--pids-limit=160',
          '--memory=768m',
          '--cpus=1',
          '--user=65534:65534',
          '--shm-size=128m',
          '--env=HOME=/tmp',
          '--env=XDG_CONFIG_HOME=/tmp/config',
          '--env=XDG_CACHE_HOME=/tmp/cache',
          '--tmpfs=/tmp:rw,nosuid,size=192m,uid=65534,gid=65534'
        ];
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
          args.push('--env', key + '=');
        for (const [src, dst, ro] of [
          [source, '/source', true],
          [runner, '/runner.mjs', true],
          [request, '/request.json', true],
          [output, '/output', false]
        ])
          args.push('--mount', `type=bind,src=${src},dst=${dst}${ro ? ',readonly' : ''}`);
        args.push('--entrypoint=node', image, '/runner.mjs');
        execution.progress?.('正在隔离浏览器中检查页面和交互…');
        started = true;
        const result = await runDocker(args, { signal, timeout: 95000 });
        if (result.exitCode) throw codeError('CODE_BROWSER_FAILED', '浏览器未完成：' + String(result.stderr || result.stdout).slice(-500));
        const raw = await fs.readFile(path.join(output, 'report.json'));
        if (raw.length > 64000) throw codeError('CODE_BROWSER_OUTPUT', '浏览器报告超过64KB');
        const report = JSON.parse(raw);
        const picture = await fs.readFile(path.join(output, 'preview.png'));
        if (picture.length > 4_000_000) throw codeError('CODE_BROWSER_OUTPUT', '截图超过4MB');
        return { ...report, ...snapshot, imageId: inspect.stdout.trim(), screenshotBytes: picture, reportBytes: raw };
      } finally {
        if (started) {
          try {
            await removeCodeContainer(name, runDocker, 10000);
          } catch {
            preserve = quarantined = true;
          }
        }
        if (directory && !preserve) await fs.rm(directory, { recursive: true, force: true });
        active--;
        if (preserve) throw codeError('CODE_SANDBOX_CLEANUP', '未确认浏览器容器清理，请管理员核查：' + name);
      }
    }
  };
}
