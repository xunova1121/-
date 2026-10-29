import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { codeError } from './codeGit.mjs';

export function dependencyPlan(pkg, lock, registry = 'https://registry.npmmirror.com') {
  const mirror = new URL(registry);
  if (mirror.protocol !== 'https:' || mirror.username || mirror.password || mirror.pathname !== '/' || mirror.search || mirror.hash)
    throw codeError('CODE_REGISTRY', 'npm源必须是无凭据、无路径的HTTPS地址');
  if (pkg.workspaces) throw codeError('CODE_PACKAGE', '本期支持独立npm项目，暂不处理workspaces');
  const hasDeps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((key) => Object.keys(pkg[key] || {}).length);
  if (!lock && hasDeps) throw codeError('CODE_LOCK_REQUIRED', '有第三方依赖时必须提供package-lock.json，不自动改动原依赖版本');
  const value = lock
    ? structuredClone(lock)
    : {
        name: pkg.name || 'code-task',
        version: pkg.version || '0.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: pkg.name || 'code-task', version: pkg.version || '0.0.0' } }
      };
  if (![2, 3].includes(value.lockfileVersion) || !value.packages || typeof value.packages !== 'object')
    throw codeError('CODE_LOCK', '需要npm lockfileVersion 2或3的锁文件');
  const entries = Object.entries(value.packages).filter(([key]) => key !== '');
  if (entries.length > 128) throw codeError('CODE_DEP_LIMIT', '依赖超过128项，本期隔离器未执行');
  const downloads = new Map();
  for (const [key, item] of entries) {
    if (!key.startsWith('node_modules/') || key.split('/').some((part) => !part || part === '.' || part === '..') || item?.link)
      throw codeError('CODE_DEP_SOURCE', '不安装本地链接、Git依赖或工作区外依赖');
    let original;
    try {
      original = new URL(item.resolved);
    } catch {
      throw codeError('CODE_DEP_SOURCE', '依赖必须锁定到HTTPS npm包');
    }
    if (
      original.protocol !== 'https:' ||
      !['https://registry.npmjs.org', mirror.origin].includes(original.origin) ||
      original.username ||
      original.password ||
      original.search ||
      original.hash ||
      !original.pathname.endsWith('.tgz')
    )
      throw codeError('CODE_DEP_SOURCE', '锁文件含非允许npm源，未下载或执行');
    if (typeof item.integrity !== 'string' || !/^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity))
      throw codeError('CODE_DEP_INTEGRITY', '依赖缺少可核验的sha256/sha512完整性');
    const id = createHash('sha256').update(item.integrity).digest('hex') + '.tgz';
    downloads.set(id, { id, url: mirror.origin + original.pathname, integrity: item.integrity });
    item.resolved = 'file:/packages/' + id;
  }
  // v2冗余dependencies也含旧URL；去掉旧视图，以packages作为npm ci唯一锁定清单。
  delete value.dependencies;
  value.lockfileVersion = 3;
  return { lock: value, downloads: [...downloads.values()], registry: mirror.origin };
}

/** 只有程序下载器联网；依赖容器随后用file tarball离线npm ci，不执行安装脚本。 */
export async function downloadDependencies(plan, directory, { signal, retrieval, fetchImpl = globalThis.fetch } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.chmod(directory, 0o755);
  let total = 0;
  const allowed = new Set([new URL(plan.registry).origin]);
  if (plan.registry === 'https://registry.npmmirror.com') allowed.add('https://cdn.npmmirror.com');
  for (const item of plan.downloads) {
    let url = new URL(item.url),
      bytes;
    for (let hop = 0; hop < 4; hop++) {
      signal?.throwIfAborted();
      if (!allowed.has(url.origin) || url.username || url.password) throw codeError('CODE_DEP_REDIRECT', 'npm包重定向到非允许源，已停止下载');
      retrieval?.consume('read');
      const response = await fetchImpl(url.href, { signal, redirect: 'manual', headers: { Accept: 'application/octet-stream' } });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw codeError('CODE_DEP_DOWNLOAD', 'npm源重定向缺少地址');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw codeError('CODE_DEP_DOWNLOAD', 'npm依赖下载失败', { upstreamStatus: response.status });
      }
      const reader = response.body?.getReader();
      if (!reader) throw codeError('CODE_DEP_DOWNLOAD', 'npm源没有返回依赖内容');
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          signal?.throwIfAborted();
          if (part.done) break;
          size += part.value.length;
          total += part.value.length;
          if (size > 8_000_000 || total > 32_000_000) throw codeError('CODE_DEP_LIMIT', '依赖包超过单包8MB/总计32MB下载上限');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      bytes = Buffer.concat(chunks);
      break;
    }
    if (!bytes) throw codeError('CODE_DEP_REDIRECT', 'npm包重定向次数超过上限');
    const [algorithm, encoded] = item.integrity.split('-'),
      expected = Buffer.from(encoded, 'base64'),
      actual = createHash(algorithm).update(bytes).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw codeError('CODE_DEP_INTEGRITY', 'npm包完整性校验失败，未交给npm安装');
    await fs.writeFile(path.join(directory, item.id), bytes, { flag: 'wx', mode: 0o644 });
    await fs.chmod(path.join(directory, item.id), 0o644);
  }
  await fs.writeFile(path.join(directory, 'lock.json'), JSON.stringify(plan.lock), { mode: 0o644 });
  await fs.chmod(path.join(directory, 'lock.json'), 0o644);
  return { packages: plan.downloads.length, downloadedBytes: total, registry: plan.registry };
}
