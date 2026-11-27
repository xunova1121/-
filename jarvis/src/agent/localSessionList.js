// 最近对话侧栏只用标题、置顶和排序时间。小条目与会话原件在一次 IndexedDB 事务中更新。
const prefix = 'session-list-row:';
const rowKeys = () => IDBKeyRange.bound(prefix, 'session-list-row;', false, true);

function listRow(session) {
  return { id: prefix + session.id, sessionId: session.id, title: session.title, pinned: !!session.pinned,
    updatedAt: session.updatedAt, excluded: !!session.evaluationId };
}

export function writeSessionsAndList(db, method, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'kv'], 'readwrite');
    const sessions = tx.objectStore('sessions'), index = tx.objectStore('kv');
    if (method === 'put') {
      sessions.put(value);
      index.put(listRow(value));
    } else if (method === 'delete') {
      sessions.delete(value);
      index.delete(prefix + value);
    } else {
      // 先构造范围再清库，确保同步参数错误也不会只清掉原件。
      index.delete(rowKeys());
      sessions.clear();
    }
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

// 新装/升级以及其他旧窗口直接新增的原件可能没有小条目。每次只解包一段旧会话，
// 就地补齐后下一次刷新只读主键和标题。重新读原件与写条目同事务，避免盖掉并发改名。
function readMissing(db, ids, rows) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'kv'], 'readwrite');
    const sessions = tx.objectStore('sessions'), index = tx.objectStore('kv');
    let next = 0;
    function read() {
      if (next === ids.length) return;
      const request = sessions.get(ids[next++]);
      request.onsuccess = () => {
        if (request.result) {
          const row = listRow(request.result);
          index.put(row);
          rows.push(row);
        }
        read();
      };
    }
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
    read();
  });
}

export async function readRecentSessionRows(db, limit) {
  const { ids, indexed } = await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'kv'], 'readonly');
    const keys = tx.objectStore('sessions').getAllKeys();
    const saved = tx.objectStore('kv').getAll(rowKeys());
    tx.oncomplete = () => resolve({ ids: keys.result, indexed: saved.result });
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  const byId = new Map(indexed.map(row => [row.sessionId, row]));
  const rows = [], missing = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) rows.push(row);
    else missing.push(id);
  }
  // 放开写锁，让老用户第一次启动时发消息、保存对话仍能穿插执行。
  for (let start = 0; start < missing.length; start += 16) {
    await readMissing(db, missing.slice(start, start + 16), rows);
  }
  return rows.filter(row => !row.excluded)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit).map(row => ({ id: row.sessionId, title: row.title, updatedAt: row.updatedAt }));
}
