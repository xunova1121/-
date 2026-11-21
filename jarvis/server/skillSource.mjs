/** 技能执行前补齐在线文本附件；只处理已安装清单，不读取用户工作区。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isBinaryFile, isRemoteFile } from '../src/agent/skillPacks.js';

export const skillError = (code, message) => Object.assign(new Error(message), { code, kind: 'api' });
export const skillQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const safeSkillPath = (name) =>
  typeof name === 'string' && name.length < 500 && !/[\\\0,:]/.test(name) && !name.split('/').some((p) => !p || p === '.' || p === '..');
export function skillSignature(pack) {
  const hash = createHash('sha256').update(String(pack.body || ''));
  for (const [name, value] of Object.entries(pack.files || {}).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify(name)).update('\0');
    if (isBinaryFile(value) && !isRemoteFile(value)) {
      const { b64, ...metadata } = value;
      hash.update(JSON.stringify(metadata)).update('\0').update(b64); // 完整参与；不再额外序列化一份上百MB的base64。
    } else hash.update(JSON.stringify(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function writeSkillSource(pack, directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.chmod(directory, 0o755);
  await fs.writeFile(path.join(directory, 'SKILL.md'), pack.body || '', { mode: 0o644 });
  await fs.chmod(path.join(directory, 'SKILL.md'), 0o644);
  for (const [name, value] of Object.entries(pack.files || {})) {
    if (!safeSkillPath(name) || isRemoteFile(value)) continue;
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    for (let parent = path.dirname(target); parent !== directory; parent = path.dirname(parent)) await fs.chmod(parent, 0o755);
    const mode = /\.(sh|py)$/.test(name) ? 0o755 : 0o644;
    await fs.writeFile(target, isBinaryFile(value) ? Buffer.from(value.b64, 'base64') : String(value), { mode });
    await fs.chmod(target, mode); // systemd的umask 077不能让容器里的nobody读不到代码。
  }
}

/** 安装身份/URL/清单不变才复用；每技能只留一份在线文本缓存（20MB）。 */
export async function materializeSkill(pack, directory, { signal, fetchImpl = globalThis.fetch, onProgress } = {}) {
  signal?.throwIfAborted();
  const entries = Object.entries(pack.files || {});
  if (entries.length > 600) throw skillError('SKILL_SOURCE_LIMIT', '技能超过600个附件，请重新安装完整且有界的技能包');
  const online = entries.filter(([name, value]) => safeSkillPath(name) && isRemoteFile(value) && !value.binary);
  if (!online.length) return pack;
  const signature = createHash('sha256')
    .update(JSON.stringify([pack.installationId, online]))
    .digest('hex');
  const cache = path.join(directory, 'online-text.json');
  let saved;
  try {
    if ((await fs.stat(cache)).size <= 25 * 1024 * 1024) saved = JSON.parse(await fs.readFile(cache, 'utf8'));
  } catch {
    /* 缓存丢失或损坏时重新取已登记附件，不当作文件已就绪。 */
  }
  if (saved?.signature === signature && online.every(([name]) => typeof saved.files?.[name] === 'string'))
    return { ...pack, files: { ...pack.files, ...saved.files } };
  onProgress?.('正在补齐技能已登记的在线脚本和校验文件…');
  const files = {};
  let total = 0;
  const timeout = AbortSignal.timeout(90000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (const [name, value] of online) {
    combined.throwIfAborted();
    let url;
    try {
      url = new URL(value.url);
    } catch {
      throw skillError('SKILL_SOURCE_URL', `技能附件没有有效下载地址：${name}，请重新安装`);
    }
    // 自动执行的代码只能来自安装器登记的GitHub raw文件；不让技能借补文件访问服务器内网。
    if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.username || url.password || url.port || url.search || url.hash)
      throw skillError('SKILL_SOURCE_URL', `无法自动准备此来源的技能脚本：${name}；请下载完整技能包后安装`);
    if (value.size > 2 * 1024 * 1024) throw skillError('SKILL_SOURCE_LIMIT', `技能文本附件超过2MB：${name}`);
    const response = await fetchImpl(url.href, { signal: combined, redirect: 'error' });
    if (!response.ok) throw skillError('SKILL_SOURCE_DOWNLOAD', `下载技能附件失败：${name}（HTTP ${response.status}）`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      total += chunk.length;
      if (bytes > 2 * 1024 * 1024 || total > 20 * 1024 * 1024) throw skillError('SKILL_SOURCE_LIMIT', '技能在线文本超过单文件2MB或合计20MB限制');
      chunks.push(chunk);
    }
    files[name] = Buffer.concat(chunks).toString('utf8');
  }
  signal?.throwIfAborted();
  await fs.mkdir(directory, { recursive: true });
  const temporary = cache + '.' + randomUUID();
  try {
    const encoded = JSON.stringify({ signature, files });
    if (Buffer.byteLength(encoded) > 25 * 1024 * 1024) throw skillError('SKILL_SOURCE_LIMIT', '技能在线文本缓存超过25MB');
    await fs.writeFile(temporary, encoded, { mode: 0o600 });
    await fs.rename(temporary, cache);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { ...pack, files: { ...pack.files, ...files } };
}
