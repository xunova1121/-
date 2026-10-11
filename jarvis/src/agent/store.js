/**
 * 本地持久化：IndexedDB（浏览器）/ 内存 Map（Node 测试或存储被禁用时）。
 * 所有数据只在这台电脑的浏览器里，不上传。
 */
const DB_NAME = 'jarvis';
const DB_VERSION = 1;
export const STORES = ['memories', 'lessons', 'skills', 'kbdocs', 'kbchunks', 'files', 'events', 'kv'];

let dbPromise = null;
const memoryDb = new Map(STORES.map((s) => [s, new Map()]));

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
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
