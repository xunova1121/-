/** 仅整理本功能新建的缓存目录；近期分享和时间不明的文件宁可保留，也不冒险中断微信读取。 */
export const SHARE_CACHE_LIMIT = 64;
const DAY = 24 * 3600_000;
const owned = entry => entry?.type === 'directory' && /^share_[A-Za-z0-9_-]{1,74}$/.test(entry.name || '');
const cacheError = message => Object.assign(new Error(message), { code: 'SHARE_CACHE_UNAVAILABLE' });

export async function prepareShareCache(Filesystem, Directory, { now = Date.now(), protectedIds = [] } = {}) {
  if (typeof Filesystem.readdir !== 'function' || typeof Filesystem.rmdir !== 'function') throw cacheError('当前版本不能安全管理分享缓存，请先保存文件后从微信发送');
  let entries;
  try { entries = (await Filesystem.readdir({ path: 'share', directory: Directory.Cache }))?.files; }
  catch (error) {
    if (error?.code === 'OS-PLUG-FILE-0008' || error?.code === 'ENOENT') return { count: 0, removed: 0 };
    throw cacheError('暂时无法检查分享缓存，请先保存文件后从微信发送');
  }
  if (!Array.isArray(entries) || entries.length > 1024) throw cacheError('分享缓存目录无法安全核对，请先保存文件');
  const folders = entries.filter(owned);
  // 时间未知按最新保留，绝不根据目录名猜时间或删除旧版share/根目录文件。
  const time = entry => Number.isFinite(entry.mtime) && entry.mtime > 0 ? entry.mtime : Infinity;
  folders.sort((a, b) => time(b) - time(a));
  const keep = new Set([...folders.slice(0, 8).map(entry => entry.name), ...protectedIds]);
  const removable = folders.filter(entry => !keep.has(entry.name) && time(entry) < now - DAY).reverse().slice(0, 16);
  let removed = 0;
  for (const entry of removable) {
    try { await Filesystem.rmdir({ path: `share/${entry.name}`, directory: Directory.Cache, recursive: true }); removed++; }
    catch { /* 保守计为未删除，达到64份后停止新增，不悄悄无限增长。 */ }
  }
  const count = folders.length - removed;
  if (count >= SHARE_CACHE_LIMIT) throw cacheError('临时分享空间已满，近期文件仍需保留；请先保存文件后从微信发送');
  return { count, removed };
}
