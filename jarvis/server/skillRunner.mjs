/**
 * 技能脚本运行器（服务器）：技能说明里要运行的命令（python / node / 命令行），放进隔离的 Docker 容器里跑，结果交回模型。
 * 手机、电脑在服务器模式下发的任务都在服务器上做，所以三端都能用带脚本的技能。
 *
 * - 镜像：deploy/skill-runner 里的 Dockerfile 构建的本地镜像（带 Python 3 和 Node），setup.sh 一键装好；
 *   默认名 jarvis-skill-runner，可用环境变量 JARVIS_SKILL_RUNNER_IMAGE 改。没有 Docker 或镜像就明确不可用，不在宿主机直接执行。
 * - 隔离：技能文件只读挂进去，每次运行一个临时工作目录；依赖装在每个技能自己的目录里；
 *   不挂未央的数据目录、不传任何密钥或环境变量；非 root、去掉全部特权、限内存 / 进程数 / 时长。
 *   可以联网（取数据的技能要联网），所以只装可信来源的技能。
 * - 依赖：照 skillDeps.js 读出的 requirements.txt / package.json / 说明里的 pip install、npm install 装，
 *   Python 包走清华镜像、npm 走 npmmirror（国内服务器连官方源很慢）；装过一次就缓存，依赖没变不重装。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { skillDeps, hasDeps, depsKey, PY_SPEC, NPM_SPEC } from '../src/agent/skillDeps.js';
import { isBinaryFile, isRemoteFile } from '../src/agent/skillPacks.js';
import { assertArchitectureMutationBatch } from '../src/agent/architectureStateProtection.js';
import { throwControl } from '../src/core/networkRequest.js';

const execute = promisify(execFile);
export const SKILL_RUNNER_IMAGE = 'jarvis-skill-runner';
const PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const NPM_REGISTRY = 'https://registry.npmmirror.com';
const RUN_MAX_S = 120;
const INSTALL_S = 300;
const OUT_MAX = 32000;
const ERR_MAX = 8000;
const FILES_MAX = 20;
const FILES_BYTES = 8 * 1024 * 1024;
const safeName = (n) => String(n ?? '').replace(/[^a-z0-9._-]/gi, '-').slice(0, 80);

export function docker(args, { signal, timeout = 25000, configDir } = {}) {
  return execute('docker', args, {
    signal,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    // 不把未央自己的环境变量（密码、密钥）带给 docker 命令；DOCKER_CONFIG 放在可写的数据目录里
    env: { PATH: process.env.PATH, ...(configDir && { DOCKER_CONFIG: configDir }), ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) }
  });
}

/** 容器的通用限制（安装和运行都一样） */
const LIMITS = ['--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--cpus=1', '--user=65534:65534'];

/**
 * @param {{ image?: string, baseDir: string, runDocker?: typeof docker, ttlMs?: number }} o
 */
export function createSkillRunner({ image = SKILL_RUNNER_IMAGE, baseDir, runDocker = docker, ttlMs = 60_000, pipIndex = process.env.JARVIS_SKILL_PIP_INDEX || PIP_INDEX, npmRegistry = process.env.JARVIS_SKILL_NPM_REGISTRY || NPM_REGISTRY }) {
  let checked = 0;
  let ok = false;
  const configDir = path.join(baseDir, '.docker');
  const dockerRun = (args, o = {}) => runDocker(args, { configDir, ...o });
  const installing = new Map();

  /** 镜像在不在（缓存一分钟） */
  async function available() {
    if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,240}$/.test(image)) return false;
    if (Date.now() - checked < ttlMs) return ok;
    checked = Date.now();
    try {
      await dockerRun(['image', 'inspect', image], { timeout: 5000 });
      ok = true;
    } catch {
      ok = false;
    }
    return ok;
  }

  /** 把技能文件写到服务器上（内容变了才重写），返回目录 */
  async function prepareSource(pack) {
    const dir = path.join(baseDir, safeName(pack.name));
    const src = path.join(dir, 'src');
    const entries = Object.entries(pack.files ?? {}).filter(([, f]) => !isRemoteFile(f));
    const sig = createHash('sha256').update(JSON.stringify([pack.body, entries.map(([k, f]) => [k, isBinaryFile(f) ? f.b64.length + ':' + f.b64.slice(0, 64) : f])])).digest('hex');
    const mark = path.join(dir, 'src.sig');
    if ((await fs.readFile(mark, 'utf8').catch(() => '')) !== sig) {
      await fs.rm(src, { recursive: true, force: true });
      await fs.mkdir(src, { recursive: true, mode: 0o755 });
      await fs.writeFile(path.join(src, 'SKILL.md'), pack.body ?? '', { mode: 0o644 });
      for (const [rel, f] of entries) {
        const parts = rel.split('/');
        if (!rel || parts.some((p) => !p || p === '..' || p === '.') || rel.startsWith('/') || rel.includes('\\')) continue;
        const target = path.join(src, ...parts);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await fs.writeFile(target, isBinaryFile(f) ? Buffer.from(f.b64, 'base64') : String(f), { mode: /\.(sh|py)$/.test(rel) ? 0o755 : 0o644 });
      }
      await fs.writeFile(mark, sig);
    }
    return { dir, src };
  }

  /** 装依赖（每个技能一份，依赖没变不重装；同一个技能同时只装一次） */
  async function ensureDeps(pack, dir, src, { signal, onProgress, extra = {} } = {}) {
    // 模型另外指定过的包记下来：下次不指定也照样在（不然每次都要重装）
    const extraFile = path.join(dir, 'extra.json');
    const saved = JSON.parse(await fs.readFile(extraFile, 'utf8').catch(() => '{}'));
    const merged = { python: [...(saved.python ?? []), ...(extra.python ?? [])], node: [...(saved.node ?? []), ...(extra.node ?? [])] };
    const deps = withExtra(skillDeps(pack), merged);
    await fs.writeFile(extraFile, JSON.stringify({ python: deps.python, node: deps.node }));
    const depsDir = path.join(dir, 'deps');
    await fs.mkdir(depsDir, { recursive: true });
    await fs.chmod(depsDir, 0o777);
    if (!hasDeps(deps)) return depsDir;
    const key = depsKey(deps);
    const mark = path.join(dir, 'deps.key');
    if ((await fs.readFile(mark, 'utf8').catch(() => '')) === key) return depsDir;
    if (installing.has(pack.name)) { await installing.get(pack.name); return depsDir; }
    const job = (async () => {
      onProgress?.('第一次用这个技能：正在装依赖（几分钟，装好以后不用再装）');
      const py = [...(deps.pythonRequirements ? ['-r', '/skill/requirements.txt'] : []), ...(deps.pythonProject ? ['/skill'] : []), ...deps.python];
      const steps = [
        py.length && `python3 -m pip install --no-cache-dir --disable-pip-version-check --target /deps/py -i ${quote(pipIndex)} ${py.map(quote).join(' ')}`,
        deps.nodePackage && `cp /skill/package.json /deps/node/ && cd /deps/node && npm install --omit=dev --no-audit --no-fund --registry=${quote(npmRegistry)}`,
        deps.node.length && `cd /deps/node && npm install --no-audit --no-fund --registry=${quote(npmRegistry)} ${deps.node.map(quote).join(' ')}`
      ].filter(Boolean);
      const script = `set -e; umask 0000; mkdir -p /deps/py /deps/node; ${steps.join('; ')}`;
      try {
        await dockerRun(['run', '--rm', ...LIMITS, '--name', `jarvis-skill-install-${randomUUID()}`, '--memory=1g', '--tmpfs=/tmp:rw,nosuid,size=512m',
          '--mount', `type=bind,src=${src},dst=/skill,readonly`, '--mount', `type=bind,src=${depsDir},dst=/deps`,
          '-e', 'HOME=/tmp', '-e', 'PIP_DISABLE_PIP_VERSION_CHECK=1', '-w', '/tmp', image, 'timeout', '--signal=KILL', `${INSTALL_S}s`, 'sh', '-c', script],
        { signal, timeout: (INSTALL_S + 20) * 1000 });
      } catch (e) {
        throw Object.assign(new Error(`技能依赖没装上：${String(e.stderr || e.message).slice(-1500)}`), { code: 'SKILL_DEPS_FAILED', kind: 'api' });
      }
      await fs.writeFile(mark, key);
    })();
    installing.set(pack.name, job);
    try { await job; } finally { installing.delete(pack.name); }
    return depsDir;
  }

  /**
   * 运行一条命令
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, files: Array<{ path: string, data: Buffer }> }>}
   */
  async function run(pack, command, { timeoutSec = 60, signal, onProgress, extra = {} } = {}) {
    const cmd = String(command ?? '').trim();
    if (!cmd || cmd.length > 4000 || cmd.includes('\0')) throw Object.assign(new Error('命令为空或太长'), { code: 'INVALID_SKILL_COMMAND' });
    if (!(await available())) throw Object.assign(new Error(UNAVAILABLE), { code: 'SKILL_RUNNER_UNAVAILABLE', kind: 'api' });
    const { dir, src } = await prepareSource(pack);
    const depsDir = await ensureDeps(pack, dir, src, { signal, onProgress, extra });
    const work = path.join(dir, 'runs', randomUUID());
    await fs.mkdir(work, { recursive: true });
    await fs.chmod(work, 0o777);
    const secs = Math.max(5, Math.min(RUN_MAX_S, Math.round(Number(timeoutSec) || 60)));
    const container = `jarvis-skill-${randomUUID()}`;
    let out = { stdout: '', stderr: '' };
    let exitCode = 0;
    let timedOut = false;
    try {
      onProgress?.(`在服务器的隔离环境里运行：${cmd.slice(0, 80)}`);
      // 技能文件复制到可写的工作目录再运行（不少脚本会在当前目录写结果）
      // umask 0：容器里（nobody 账号）做出的文件，运行未央的账号事后也能读、能删
      const script = 'umask 0000; cp -r /skill/. /work/ 2>/dev/null; cd /work && eval "$JARVIS_CMD"';
      out = await dockerRun(['run', '--rm', ...LIMITS, '--name', container, '--memory=512m', '--tmpfs=/tmp:rw,nosuid,size=128m',
        '--mount', `type=bind,src=${src},dst=/skill,readonly`, '--mount', `type=bind,src=${depsDir},dst=/deps,readonly`, '--mount', `type=bind,src=${work},dst=/work`,
        '-e', 'HOME=/tmp', '-e', 'PYTHONPATH=/deps/py', '-e', 'NODE_PATH=/deps/node/node_modules', '-e', 'PYTHONUNBUFFERED=1',
        '-e', 'PATH=/deps/py/bin:/deps/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin', '-e', `JARVIS_CMD=${cmd}`,
        '-w', '/work', image, 'timeout', '--signal=KILL', `${secs}s`, 'sh', '-c', script],
      { signal, timeout: (secs + 15) * 1000 });
    } catch (e) {
      if (signal?.aborted) { await dockerRun(['rm', '-f', container], { timeout: 5000 }).catch(() => {}); throw e; }
      // 命令自己失败（退出码非 0）也是结果：交回模型看错误信息
      out = { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) };
      exitCode = typeof e.code === 'number' ? e.code : 1;
      timedOut = exitCode === 137 || Boolean(e.killed);
      if (e.killed) await dockerRun(['rm', '-f', container], { timeout: 5000 }).catch(() => {});
    }
    const files = await producedFiles(work, src).catch(() => []);
    await removeWork(work);
    return { exitCode, timedOut, stdout: String(out.stdout || '').slice(-OUT_MAX), stderr: String(out.stderr || '').slice(-ERR_MAX), files };
  }

  /** 删掉这次运行的临时目录；有删不掉的（容器里别的账号建的）就再起一个容器删 */
  async function removeWork(work) {
    try {
      await fs.rm(work, { recursive: true, force: true });
    } catch {
      await dockerRun(['run', '--rm', ...LIMITS, '--mount', `type=bind,src=${work},dst=/work`, image, 'sh', '-c', 'rm -rf /work/* /work/.[!.]* 2>/dev/null; true'], { timeout: 30000 }).catch(() => {});
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { available, run, image };
}

/** 模型另外指定要装的包（技能说明里没写、写在仓库首页的那种）：只收包名和版本号 */
function withExtra(deps, { python = [], node = [] } = {}) {
  const py = [...new Set([...deps.python, ...(Array.isArray(python) ? python : []).map(String).filter((p) => PY_SPEC.test(p))])].slice(0, 40);
  const js = [...new Set([...deps.node, ...(Array.isArray(node) ? node : []).map(String).filter((p) => NPM_SPEC.test(p))])].slice(0, 40);
  return { ...deps, python: py, node: js };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 这次运行新做出来的文件（技能自带的不算），最多 20 个、8 MB */
async function producedFiles(work, src) {
  const out = [];
  let bytes = 0;
  async function walk(rel) {
    for (const ent of await fs.readdir(path.join(work, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (out.length >= FILES_MAX) return;
      if (ent.isDirectory()) { if (!/^(node_modules|__pycache__|\.git)$/.test(ent.name)) await walk(r); continue; }
      if (!ent.isFile()) continue;
      const full = path.join(work, r);
      const st = await fs.stat(full);
      // 技能自带、内容没变的文件不算
      const orig = await fs.readFile(path.join(src, r)).catch(() => null);
      if (orig && orig.length === st.size && orig.equals(await fs.readFile(full))) continue;
      if (bytes + st.size > FILES_BYTES) continue;
      bytes += st.size;
      out.push({ path: r, data: await fs.readFile(full) });
    }
  }
  await walk('');
  return out;
}

export const UNAVAILABLE = '服务器还没装技能运行器（Docker 里的 Python / Node 环境），运行不了技能里的脚本。装法：在服务器上用 root 运行 bash /opt/jarvis/current/deploy/skill-runner/setup.sh（见 deploy/服务器部署说明.md“技能运行器”一节）。';

/**
 * 给模型用的工具
 * @param {{ runner: ReturnType<typeof createSkillRunner>, getPack: (name: string) => Promise<object|null>, saveFile: (path: string, data: Buffer) => Promise<void> }} o
 */
export function skillRunnerTool({ runner, getPack, saveFile }) {
  return {
    name: 'run_skill_command',
    description: '在服务器的隔离环境（Docker，带 Python 3 和 Node，可以联网）里运行已安装技能说明中的命令，比如“python scripts/report.py --team 山东泰山”“sports-skills football get_scoreboard”。先用 use_skill 读技能说明，照说明里的命令写；工作目录就是技能文件夹，依赖第一次用时自动装（可能要几分钟）。命令做出的新文件会存进工作区 skills-output/<技能名>/。每次最长 2 分钟，读不到你的对话、记忆和密钥。命令失败会返回错误信息，看懂再改，别原样重试；报“找不到命令 / No module named”多半是没装包：照技能或它所在仓库首页写的 pip install / npm install，把包名填进 python_packages / npm_packages 再运行。',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名（use_skill 里的名字）' },
        command: { type: 'string', description: '要运行的命令，照技能说明写' },
        timeout_seconds: { type: 'number', description: '最长运行秒数，默认 60，最多 120' },
        python_packages: { type: 'array', items: { type: 'string' }, description: '可选：技能说明里没写、但运行要先 pip install 的包（如技能仓库首页写的 sports-skills），只写包名或“包名==版本”，装一次以后缓存' },
        npm_packages: { type: 'array', items: { type: 'string' }, description: '可选：要先 npm install 的包，只写包名或“包名@版本”' }
      },
      required: ['skill', 'command'],
      additionalProperties: false
    },
    run: async ({ skill, command, timeout_seconds, python_packages, npm_packages }, { signal, progress } = {}) => {
      throwControl(null, signal);
      const pack = await getPack(skill);
      if (!pack) throw Object.assign(new Error(`服务器上没有技能「${skill}」：先在“技能”里安装，并同步到服务器`), { code: 'SKILL_NOT_FOUND', kind: 'api' });
      if (pack.enabled === false) throw Object.assign(new Error(`技能「${pack.name}」已停用`), { code: 'SKILL_DISABLED', kind: 'api' });
      throwControl(null, signal);
      const r = await runner.run(pack, command, { timeoutSec: timeout_seconds, signal, onProgress: progress, extra: { python: python_packages, node: npm_packages } });
      throwControl(null, signal);
      const outputs = r.files.map(file => ({ path: `skills-output/${safeName(pack.name)}/${file.path}`, data: file.data }));
      // 容器前缀不等于内容可信；整个结果批次先核对，不能先保存普通文件再伪造架构清单。
      await assertArchitectureMutationBatch(outputs, { signal });
      const saved = [];
      for (const file of outputs) {
        throwControl(null, signal);
        await saveFile(file.path, file.data);
        saved.push(file.path);
      }
      return [
        `退出码：${r.exitCode}${r.timedOut ? '（超时被停止）' : ''}`,
        r.stdout.trim() && `输出：\n${r.stdout.trim()}`,
        r.stderr.trim() && `错误输出：\n${r.stderr.trim()}`,
        saved.length && `做出的文件（已存进工作区）：\n${saved.map((p) => `- /workspace/${p}`).join('\n')}`
      ].filter(Boolean).join('\n\n');
    }
  };
}
