/**
 * 本地持久化：IndexedDB（浏览器）/ 内存 Map（Node 测试或存储被禁用时）。
 * 所有数据只在这台电脑的浏览器里，不上传。
 */
const DB_NAME = 'jarvis';
// v2：packs（安装的技能）；v3：episodes（对话摘要）；v4：sessions（多会话）；v5：fileVersions（工作区文件的旧版本）
// 升级只新建缺少的表，不动已有的表和数据（tests/storeUpgrade.test.js 模拟了从 v4 升级）
const DB_VERSION = 5;
export const STORES = ['memories', 'lessons', 'skills', 'packs', 'episodes', 'sessions', 'kbdocs', 'kbchunks', 'files', 'events', 'kv', 'fileVersions'];

let dbPromise = null;
let problem = '';
const memoryDb = new Map(STORES.map((s) => [s, new Map()]));

/** 打开数据库，返回存储出问题时给用户看的说明（没问题为空字符串） */
export const storageProblem = () => openDb().then(() => problem);

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const ready = (db) => {
        // 以后的新版本要升级时，这个页面主动让路，不挡住升级
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => ready(req.result);
      req.onerror = () => {
        // 数据库已经被更新的未央升级过（比如另一个标签页是新版）：按现有版本打开，表只多不少
        if (req.error?.name !== 'VersionError') return resolve(null);
        const again = indexedDB.open(DB_NAME);
        again.onsuccess = () => ready(again.result);
        again.onerror = () => resolve(null);
      };
      req.onblocked = () => {
        // 另一个标签页还开着旧版未央，升级要等它关掉。数据都还在，只是这个页面暂时读不到
        problem = '另一个未央页面还开着旧版本，请关掉它后刷新本页。在那之前，这里看不到之前的对话和记忆，新的改动也不会保存。';
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** 某个集合的增删查 */
export function collection(name) {
  return {
    async all() {
      const db = await openDb();
      if (!db) return [...memoryDb.get(name).values()];
      return tx(db, name, 'readonly', (s) => s.getAll());
    },
    async get(id) {
      const db = await openDb();
      if (!db) return memoryDb.get(name).get(id);
      return tx(db, name, 'readonly', (s) => s.get(id));
    },
    async put(obj) {
      const db = await openDb();
      if (!db) { memoryDb.get(name).set(obj.id, obj); return obj; }
      await tx(db, name, 'readwrite', (s) => s.put(obj));
      return obj;
    },
    async delete(id) {
      const db = await openDb();
      if (!db) { memoryDb.get(name).delete(id); return; }
      await tx(db, name, 'readwrite', (s) => s.delete(id));
    },
    async clear() {
      const db = await openDb();
      if (!db) { memoryDb.get(name).clear(); return; }
      await tx(db, name, 'readwrite', (s) => s.clear());
    }
  };
}

export const uid = (p = '') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
