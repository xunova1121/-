import { collection } from '../agent/store.js';
import { fileCategory } from './fileOrganization.js';
const kv = collection('kv');
export const CATALOG_LIMIT = 2000;
export const PROCESS_FILE = /(?:^|\/)(?:文档检查|\.workflows|\.checkpoints|检查记录)\//i;
const rank = (path) => ['docx', 'xlsx', 'pptx', 'svg', 'pdf', 'png'].indexOf(String(path).split('.').pop().toLowerCase());
function cleanItems(items) {
  const entries = Object.entries(items);
  if (entries.length > CATALOG_LIMIT) throw Object.assign(new Error('文件管理标记超过2000条'), { code: 'CATALOG_LIMIT', kind: 'storage' });
  const clean = Object.create(null);
  for (const [path, meta] of entries) {
    if (path.length > 600 || !meta || typeof meta !== 'object') continue;
    const value = {};
    if (typeof meta.title === 'string') value.title = meta.title.slice(0, 160);
    if (typeof meta.project === 'string') value.project = meta.project.slice(0, 80);
    if (typeof meta.favorite === 'boolean') value.favorite = meta.favorite;
    if (typeof meta.trash === 'boolean') value.trash = meta.trash;
    clean[path] = value;
  }
  return clean;
}
export const catalogKey = (scope) => 'workspace-catalog:' + String(scope).slice(0, 240);

/** 元数据最多2000个路径，只保存显示名/项目/收藏/回收站，不移动原文件或破坏旧链接。 */
export async function loadCatalog(scope) {
  const record = await kv.get(catalogKey(scope));
  return record?.items && typeof record.items === 'object' ? cleanItems(record.items) : {};
}
export async function saveCatalog(scope, items) {
  if (Object.keys(items).length > CATALOG_LIMIT)
    throw Object.assign(new Error('文件管理标记超过2000条，请先清理不用的标记'), { code: 'CATALOG_LIMIT', kind: 'storage' });
  await kv.put({ id: catalogKey(scope), items: cleanItems(items) });
}
let writeTail = Promise.resolve();
let pendingWrites = 0;
/** 标记按最新状态合并，快速连续操作也不把另一个成果的收藏/项目覆盖掉。 */
export function patchCatalog(scope, paths, patch) {
  if (pendingWrites >= 32) throw Object.assign(new Error('文件管理操作繁忙，请稍后重试'), { code: 'CATALOG_BUSY', kind: 'storage' });
  pendingWrites++;
  const work = writeTail
    .catch(() => {})
    .then(async () => {
      const items = await loadCatalog(scope);
      for (const path of paths.slice(0, CATALOG_LIMIT)) {
        if (patch === null) delete items[path];
        else items[path] = { ...(items[path] || {}), ...patch };
      }
      await saveCatalog(scope, items);
    });
  writeTail = work;
  return work.finally(() => {
    pendingWrites--;
  });
}
export function catalogGroups(files, { items = {}, query = '', view = 'recent', category = 'all', project = '', process = false, records = [] } = {}) {
  const sources = new Map();
  for (const record of records.slice(0, 200)) for (const path of record.files || []) if (!sources.has(path)) sources.set(path, record);
  const groups = new Map();
  const q = String(query).trim().toLowerCase();
  for (const file of files) {
    const meta = items[file.path] || {};
    const trash = Boolean(meta.trash);
    if (trash !== (view === 'trash')) continue;
    if (!process && !q && PROCESS_FILE.test(file.path)) continue;
    if (view === 'favorites' && !meta.favorite) continue;
    if (category !== 'all' && fileCategory(file.path) !== category) continue;
    if (project && meta.project !== project) continue;
    if (q && !`${file.path} ${meta.title || ''} ${meta.project || ''}`.toLowerCase().includes(q)) continue;
    const stem = file.path.replace(/\.[^/.]+$/, '');
    // 只归拢同目录同名文件；不同目录或用户指定不同项目不能合并成同一成果。
    const key = stem + '\0' + (meta.project || '');
    if (!groups.has(key))
      groups.set(key, { key, title: meta.title || stem.split('/').pop(), project: meta.project || '', favorite: false, mtime: 0, files: [], source: null });
    const group = groups.get(key);
    group.files.push(file);
    group.favorite ||= Boolean(meta.favorite);
    group.mtime = Math.max(group.mtime, Number(file.mtime) || 0);
    group.source ||= sources.get(file.path) || null;
  }
  for (const group of groups.values()) group.files.sort((a, b) => (rank(a.path) < 0 ? 99 : rank(a.path)) - (rank(b.path) < 0 ? 99 : rank(b.path)));
  return [...groups.values()].sort((a, b) =>
    view === 'projects' ? a.project.localeCompare(b.project, 'zh-CN') || b.mtime - a.mtime : b.mtime - a.mtime || a.title.localeCompare(b.title, 'zh-CN')
  );
}
