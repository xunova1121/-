/** 固定源码的代码评测入口检查：校验完所有文件与实际导入后，才允许独立实测进程启动。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepareRuntime, validateRuntimeManifest } from './architecture-runtime-fetch.mjs';

export const CODE_RUNTIME_REQUIRED = Object.freeze([
  'package.json',
  'package-lock.json',
  'evals/code-server.mjs',
  'evals/code-server-acceptance.mjs',
  'evals/code-live-config.mjs',
  'evals/code-runtime.mjs',
  'evals/run-code-server.sh',
  'evals/architecture-runtime-fetch.mjs',
  'server/taskRunner.mjs',
  'server/codeRepos.mjs',
  'server/codeDocker.mjs',
  'server/codeTaskPolicy.mjs',
  'src/agent/agent.js',
  'src/agent/codeDevelopment.js'
]);
const invalid = (code, message) => Object.assign(new Error(message), { code });
export function validateCodeRuntimeManifest(manifest) {
  try {
    validateRuntimeManifest(manifest);
  } catch {
    throw invalid('CODE_RUNTIME_MANIFEST', '代码评测清单格式、路径或容量不合法，未请求模型');
  }
  const names = new Set(manifest.files.map((file) => file.path));
  const missing = CODE_RUNTIME_REQUIRED.filter((name) => !names.has(name));
  if (missing.length) throw invalid('CODE_RUNTIME_MANIFEST', '代码评测清单缺少运行入口：' + missing.join('、'));
  return manifest;
}

export async function checkCodeRuntime(manifest, directory) {
  validateCodeRuntimeManifest(manifest);
  const root = await fs.realpath(directory);
  const listed = new Set(manifest.files.map((entry) => entry.path));
  let visited = 0;
  async function scan(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const name = relative + '/' + item.name;
      if (++visited > 2000 || item.isSymbolicLink()) throw invalid('CODE_RUNTIME_EXTRA', '代码目录出现未核验路径，未请求模型');
      if (item.isDirectory()) await scan(name);
      else if (!item.isFile() || !listed.has(name)) throw invalid('CODE_RUNTIME_EXTRA', '代码目录存在清单之外的文件，未请求模型：' + name);
    }
  }
  for (const scope of ['src', 'server', 'shared', 'evals']) await scan(scope);
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch {
      throw invalid('CODE_RUNTIME_HASH', '准备的代码文件缺失，未请求模型：' + entry.path);
    }
    if (
      !stat.isFile() ||
      stat.size !== entry.bytes ||
      createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex') !== entry.sha256
    )
      throw invalid('CODE_RUNTIME_HASH', '准备的代码大小或哈希不符，未请求模型：' + entry.path);
  }
  try {
    // 只导入，不调用main；Node真实检查相对模块和已安装的运行依赖，不靠手写正则猜导入。
    const entry = await import(pathToFileURL(path.join(root, 'evals/code-server.mjs')).href);
    if (typeof entry.main !== 'function') throw new Error('entry');
  } catch {
    throw invalid('CODE_RUNTIME_DEPENDENCY', '代码评测入口或运行依赖不能加载；请检查npm依赖安装，未请求模型');
  }
  return { state: 'entry_loadable', revision: manifest.revision, files: manifest.files.length, modelRequested: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let temporary;
  try {
    const args = process.argv.slice(2);
    const fromSource = args[0] === '--from-source';
    const [manifestFile, directory] = fromSource ? args.slice(1) : args;
    const blob = await fs.readFile(manifestFile);
    if (blob.length > 1e6) throw invalid('CODE_RUNTIME_MANIFEST', '代码评测清单过大');
    const manifest = validateCodeRuntimeManifest(JSON.parse(blob));
    let runtime = directory;
    if (fromSource) {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'code-runtime-prepared-'));
      await prepareRuntime(manifest, directory, temporary, {
        fetchFile: async () => {
          throw invalid('CODE_RUNTIME_SOURCE', '当前源码与固定清单不符，不联网补齐冒充当前源码通过');
        }
      });
      await fs.symlink(path.join(await fs.realpath(directory), 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
      runtime = temporary;
    }
    const result = await checkCodeRuntime(manifest, runtime);
    console.log(`代码入口和依赖可加载：${result.files}文件；尚未请求模型`);
  } catch (error) {
    console.error(error.code?.startsWith('CODE_RUNTIME_') ? error.message : '代码评测清单读取失败，未请求模型');
    process.exitCode = 1;
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}
