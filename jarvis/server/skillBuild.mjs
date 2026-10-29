/** 只在独立副本里构建技能；不运行宿主命令，不把安装中的技能挂为可写。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { skillError, skillQuote, safeSkillPath, skillSignature, writeSkillSource } from './skillSource.mjs';
import { removeCodeContainer } from './codeDocker.mjs';

/** 优先标准prepare/generate/build；其次只运行技能内现存的Node生成脚本，不盲跑文档站点。 */
export function skillBuildPlan(pack) {
  const files = pack.files || {};
  const candidates = Object.keys(files).filter((name) => safeSkillPath(name) && /^(?:[^/]+\/)?package\.json$/.test(name) && typeof files[name] === 'string');
  const plans = [];
  for (const name of candidates) {
    let pkg;
    try {
      pkg = JSON.parse(files[name]);
    } catch {
      throw skillError('SKILL_BUILD_PACKAGE', `技能${name}不是有效JSON`);
    }
    const root = name.slice(0, -'package.json'.length);
    const scripts = pkg.scripts || {};
    let steps = scripts.prepare ? ['prepare'] : ['generate', 'build'].filter((key) => scripts[key]);
    if (!steps.length)
      steps = Object.keys(scripts).filter((key) => {
        if (!/^generate:[a-z0-9-]+$/i.test(key)) return false;
        const entry = /^node\s+([a-zA-Z0-9_./-]+)(?:\s|$)/.exec(scripts[key])?.[1]?.replace(/^\.\//, '');
        return entry && safeSkillPath(entry) && typeof files[root + entry] === 'string';
      });
    if (!steps.length) continue;
    if (steps.length > 4 || steps.some((key) => typeof scripts[key] !== 'string' || scripts[key].length > 2000))
      throw skillError('SKILL_BUILD_STEPS', '技能构建步骤超过4项或脚本无效，请提供明确的prepare/build入口');
    plans.push({
      root: root.replace(/\/$/, ''),
      steps,
      dependency: ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => Object.keys(pkg[key] || {}).length)
    });
  }
  const root = plans.find((plan) => !plan.root);
  if (root) return root;
  if (plans.length > 1) throw skillError('SKILL_BUILD_PACKAGE', '发现多个可构建技能目录，请安装单个技能文件夹');
  return plans[0] || null;
}

/** 缓存每技能最多2个版本，单版本最多12000文件/128MB；拒绝逃逸链接，不清仍在用的版本。 */
async function inspectBuild(directory) {
  let count = 0,
    bytes = 0;
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const target = path.join(directory, relative, item.name);
      if (++count > 12000) throw skillError('SKILL_BUILD_LIMIT', '技能构建超过12000文件');
      if (item.isDirectory()) await walk(path.join(relative, item.name));
      else if (item.isSymbolicLink()) {
        const actual = await fs.realpath(target);
        if (!actual.startsWith(directory + path.sep)) throw skillError('SKILL_BUILD_PATH', '技能构建产生目录外链接，未运行');
      } else if (item.isFile()) {
        bytes += (await fs.stat(target)).size;
        if (bytes > 128 * 1024 * 1024) throw skillError('SKILL_BUILD_LIMIT', '技能构建超过128MB');
      } else throw skillError('SKILL_BUILD_PATH', '技能构建含不支持的特殊文件');
    }
  }
  await walk('');
}

export function createSkillBuilder({ image, dockerRun, limits, registry }) {
  const jobs = new Map(),
    active = new Map(),
    promoting = new Map();
  async function promote(home, stage, source, signal) {
    const previous = promoting.get(home);
    let unlock;
    const held = new Promise((resolve) => {
      unlock = resolve;
    });
    promoting.set(home, held);
    try {
      await previous;
      signal?.throwIfAborted();
      const old = (await fs.readdir(home)).filter((name) => /^[a-f0-9]{64}$/.test(name));
      for (const name of [...old])
        if (!active.has(path.join(home, name)) && old.length >= 2) {
          await fs.rm(path.join(home, name), { recursive: true, force: true });
          old.splice(old.indexOf(name), 1);
        }
      if (old.length >= 2) throw skillError('SKILL_BUILD_BUSY', '此技能的旧构建仍在运行，暂不清理或覆盖');
      await fs.rename(stage, source);
    } finally {
      unlock();
      if (promoting.get(home) === held) promoting.delete(home);
    }
  }
  async function prepare(pack, directory, options = {}) {
    const { signal, onProgress } = options;
    signal?.throwIfAborted();
    const plan = skillBuildPlan(pack);
    if (!plan) return null;
    const key = createHash('sha256')
      .update(JSON.stringify([1, image, registry, plan, skillSignature(pack)]))
      .digest('hex');
    const home = path.join(directory, 'builds'),
      source = path.join(home, key);
    const id = source;
    if (active.size >= 8 && !active.has(source)) throw skillError('SKILL_BUILD_BUSY', '正在运行的技能较多，请稍后再试');
    const owner = !jobs.has(id);
    if (owner) {
      if (jobs.size >= 8) throw skillError('SKILL_BUILD_BUSY', '正在准备的技能较多，请稍后再试');
      const job = build().finally(() => jobs.delete(id));
      jobs.set(id, job);
    }
    // 从等待开始保护该版本，避免另一内容版本在准备/复制期间把它清掉。
    active.set(source, (active.get(source) || 0) + 1);
    const release = () => {
      const n = (active.get(source) || 1) - 1;
      if (n) active.set(source, n);
      else active.delete(source);
    };
    try {
      // 排队等待者可立即取消；发起构建者须等待容器清理确认后才退出。
      if (owner || !signal) await jobs.get(id);
      else {
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        });
        try {
          signal.throwIfAborted();
          await Promise.race([jobs.get(id), cancelled]);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }
      signal?.throwIfAborted();
      return { src: source, plan, release };
    } catch (error) {
      release();
      throw error;
    }

    async function build() {
      await fs.mkdir(home, { recursive: true });
      if (await fs.stat(path.join(home, '.cleanup-blocked')).catch(() => null))
        throw skillError('SKILL_BUILD_CLEANUP', '上次技能构建容器尚未确认清理，请管理员核查后再运行');
      if (await fs.stat(path.join(source, '.weiyang-build-ready')).catch(() => null)) return;
      const stage = path.join(home, '.building-' + randomUUID());
      const container = 'jarvis-skill-build-' + randomUUID();
      let removable = true;
      try {
        await writeSkillSource(pack, stage);
        // 只有独立构建副本可写，容器非root；原技能包和用户目录均不挂入。
        async function writable(dir) {
          await fs.chmod(dir, 0o777);
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) await writable(path.join(dir, entry.name));
            else {
              const file = path.join(dir, entry.name);
              await fs.chmod(file, (await fs.stat(file)).mode | 0o222);
            }
          }
        }
        await writable(stage);
        const packageDir = plan.root ? '/build/' + plan.root : '/build';
        const install = plan.dependency
          ? `npm ${typeof pack.files[(plan.root ? plan.root + '/' : '') + 'package-lock.json'] === 'string' ? 'ci' : 'install'} --include=dev --ignore-scripts --no-audit --no-fund --registry=${skillQuote(registry)}; `
          : '';
        const script =
          `set -eu; umask 0000; cd ${skillQuote(packageDir)}; ${install}` + plan.steps.map((step) => `npm --ignore-scripts run ${skillQuote(step)}`).join('; ');
        onProgress?.(`第一次准备技能构建：${plan.steps.join('、')}（同稿完成后复用）`);
        let failure;
        removable = false;
        try {
          await dockerRun(
            [
              'run',
              '--rm',
              ...limits,
              '--name',
              container,
              '--memory=1g',
              '--tmpfs=/tmp:rw,nosuid,size=256m',
              '--mount',
              `type=bind,src=${stage},dst=/build,readonly=false`,
              '-e',
              'HOME=/tmp',
              '-e',
              'npm_config_cache=/tmp/npm',
              '-e',
              `JARVIS_BUILD_STEPS=${plan.steps.join(',')}`,
              '-w',
              packageDir,
              image,
              'timeout',
              '--signal=KILL',
              '300s',
              'sh',
              '-c',
              script
            ],
            { signal, timeout: 315000 }
          );
        } catch (error) {
          failure = error;
        } finally {
          try {
            await removeCodeContainer(container, async (args, opts) => ({ exitCode: 0, ...(await dockerRun(args, opts)) }), 5000);
            removable = true;
          } catch {
            await fs.writeFile(path.join(home, '.cleanup-blocked'), container, { mode: 0o600 });
            throw skillError('SKILL_BUILD_CLEANUP', '技能构建容器未确认清理，已保留副本并暂停后续构建：' + container);
          }
        }
        signal?.throwIfAborted();
        if (failure) {
          if (failure.killed || [124, 137].includes(failure.code))
            throw skillError('SKILL_BUILD_TIMEOUT', '技能构建超过5分钟或被资源限制停止；没有缓存成功，请检查技能构建脚本');
          throw skillError('SKILL_BUILD_FAILED', `技能构建失败（${plan.steps.join('、')}）：${String(failure.stderr || failure.message).slice(-1200)}`);
        }
        await inspectBuild(stage);
        await fs.writeFile(path.join(stage, '.weiyang-build-ready'), key, { mode: 0o644 });
        await fs.chmod(path.join(stage, '.weiyang-build-ready'), 0o644);
        await promote(home, stage, source, signal);
      } finally {
        if (removable) await fs.rm(stage, { recursive: true, force: true });
      }
    }
  }
  return { prepare };
}
