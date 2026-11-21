import { updateFileRecord } from './store.js';

export const hasActiveFile = row => row?.data != null;
const hasTrash = row => row?.trashData != null;
export const trashInfo = row => hasTrash(row) ? { path: row.id, size: row.trashSize, mtime: row.trashMtime, trashedAt: row.trashedAt } : null;
const activeInfo = row => ({ path: row.id, size: row.size, mtime: row.mtime });
const fail = (message, status, code) => Object.assign(new Error(message), { status, code, kind: 'input' });
export const remainingTrash = row => hasTrash(row) ? {
  id: row.id, trashData: row.trashData, trashSize: row.trashSize, trashMtime: row.trashMtime, trashedAt: row.trashedAt
} : null;
const remainingActive = row => hasActiveFile(row) ? { id: row.id, data: row.data, size: row.size, mtime: row.mtime } : null;
export const fileTimestamp = row => Math.max(Date.now(), (row?.mtime || 0) + 1, (row?.trashedAt || 0) + 1);

export function checkSnapshot(info, expected) {
  if (['size', 'mtime', 'trashedAt'].some(key => expected?.[key] !== undefined && expected[key] !== info[key]))
    throw fail('文件已发生变化，请刷新并重新确认：' + info.path, 409, 'WORKSPACE_FILE_CHANGED');
}

/** 执行用户确认的清单，最多四项在途。中止后只等待在途回执，剩余项标为未执行。 */
export async function trashSnapshot(items, { trashFile, signal, onProgress }) {
  const snapshot = items.map(({ path, size, mtime }) => ({ path, size, mtime }));
  const total = snapshot.length;
  const results = new Array(total);
  let next = 0, done = 0;
  async function worker() {
    while (!signal?.aborted && next < total) {
      const i = next++;
      const file = snapshot[i];
      try {
        if (!file.path || !Number.isFinite(file.size) || !Number.isFinite(file.mtime))
          throw new Error('快照缺少路径、大小或修改时间，请刷新文件清单');
        const receipt = await trashFile(file.path, file);
        if (receipt?.path !== file.path) throw new Error('没有收到对应文件的回收回执');
        results[i] = { path: file.path };
      } catch (error) {
        results[i] = { path: file.path, reason: error?.message || '文件操作失败' };
      }
      done++;
      try { onProgress?.({ done, total }); } catch { /* 展示进度失败不能影响已确认的文件操作 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  const paths = [], errors = [];
  for (let i = 0; i < total; i++) {
    const result = results[i] || { path: snapshot[i].path, reason: '已停止，未执行' };
    if (result.reason) errors.push(result); else paths.push(result.path);
  }
  return { paths, errors };
}

export async function changeTrash(path, action, expected) {
  let result;
  await updateFileRecord(path, row => {
    if (action === 'trash') {
      if (!hasActiveFile(row)) throw fail('工作区没有这个文件：' + path, 404, 'WORKSPACE_NOT_FOUND');
      checkSnapshot(activeInfo(row), expected);
      if (hasTrash(row)) throw fail('回收站已保存同名文件，请先处理旧记录：' + path, 409, 'WORKSPACE_TRASH_CONFLICT');
      const next = { id: path, trashData: row.data, trashSize: row.size, trashMtime: row.mtime, trashedAt: fileTimestamp(row) };
      result = trashInfo(next);
      return next;
    }
    const info = trashInfo(row);
    if (!info) throw fail('回收站没有这个文件：' + path, 404, 'WORKSPACE_TRASH_NOT_FOUND');
    checkSnapshot(info, expected);
    if (action === 'restore') {
      if (hasActiveFile(row)) throw fail('工作区已存在同名文件，已保留两份内容：' + path, 409, 'WORKSPACE_RESTORE_CONFLICT');
      const next = { id: path, data: row.trashData, size: row.trashSize, mtime: fileTimestamp(row) };
      result = activeInfo(next);
      return next;
    }
    if (action !== 'purge') throw new Error('未知的回收站操作');
    result = info;
    return remainingActive(row);
  });
  return result;
}
