/**
 * 本地数据库升级（v4 → v5，新增 fileVersions 表）：用 fake-indexeddb 模拟真实浏览器里的 IndexedDB，
 * 先按旧版本建库、放进会话 / 记忆 / 工作区文件，再用新代码打开，确认数据一条不少。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// v4 的表（升级前的未央）
const V4_STORES = ['memories', 'lessons', 'skills', 'packs', 'episodes', 'sessions', 'kbdocs', 'kbchunks', 'files', 'events', 'kv'];

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** 按旧版本建库并写入数据；keepOpen 时不关闭（模拟另一个标签页还开着旧版） */
async function makeOldDb(version, data, { keepOpen = false } = {}) {
  const open = indexedDB.open('jarvis', version);
  open.onupgradeneeded = () => { for (const s of V4_STORES) open.result.createObjectStore(s, { keyPath: 'id' }); };
  const db = await req(open);
  for (const [store, rows] of Object.entries(data)) {
    const t = db.transaction(store, 'readwrite');
    for (const r of rows) t.objectStore(store).put(r);
    await new Promise((resolve) => { t.oncomplete = resolve; });
  }
  if (!keepOpen) db.close();
  return db;
}

const OLD_DATA = {
  sessions: [{ id: 's_old', title: '杭州三日游', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: '预算 3000 元', ts: 1 }] }],
  memories: [{ id: 'm_old', content: '用户喜欢喝美式咖啡', category: 'preference', importance: 3, ts: 1 }],
  files: [{ id: 'notes/计划.md', data: new Blob(['# 第一天：西湖']), size: 22, mtime: 1 }],
  kv: [{ id: 'core', human: '用户叫小许', persona: '' }]
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // 每个测试一个全新的“浏览器”
  vi.resetModules(); // store.js 会缓存打开的数据库，每次重新加载
});
afterEach(() => { delete globalThis.indexedDB; });

describe('本地数据库从 v4 升级到 v5', () => {
  it('原来的会话、记忆、工作区文件、核心记忆都还在，新表可以用', async () => {
    await makeOldDb(4, OLD_DATA);
    const store = await import('../src/agent/store.js');
    expect(await store.storageProblem()).toBe('');
    const sessions = await import('../src/agent/sessions.js');
    const ws = await import('../src/agent/workspace.js');
    const memory = await import('../src/agent/memory.js');

    const [s] = await sessions.list();
    expect(s).toMatchObject({ id: 's_old', title: '杭州三日游' });
    expect((await sessions.get('s_old')).messages[0].content).toBe('预算 3000 元');
    expect((await memory.listAll()).memories.map((m) => m.content)).toContain('用户喜欢喝美式咖啡');
    expect((await memory.getCore()).human).toBe('用户叫小许');
    expect(await ws.readText('notes/计划.md')).toBe('# 第一天：西湖');

    // 新表：覆盖旧文件时留下旧版本
    await ws.write('notes/计划.md', '# 第一天：灵隐寺');
    const history = await import('../src/agent/fileHistory.js');
    const [v] = await history.list();
    expect(v).toMatchObject({ path: 'notes/计划.md', op: 'overwrite', stored: true });

    // 真的升级到了 v5，并且旧表都在
    const db = await req(indexedDB.open('jarvis'));
    expect(db.version).toBe(5);
    expect([...db.objectStoreNames].sort()).toEqual([...V4_STORES, 'fileVersions'].sort());
    db.close();
  });

  it('升级后关掉再打开（刷新页面）：数据和新表里的旧版本都还在', async () => {
    await makeOldDb(4, OLD_DATA);
    let ws = await import('../src/agent/workspace.js');
    await ws.write('notes/计划.md', '改过的');
    // 模拟刷新：关掉连接，重新加载模块
    (await req(indexedDB.open('jarvis'))).close();
    vi.resetModules();
    ws = await import('../src/agent/workspace.js');
    const history = await import('../src/agent/fileHistory.js');
    const [v] = await history.list();
    await ws.restoreVersion(v.id);
    expect(await ws.readText('notes/计划.md')).toBe('# 第一天：西湖');
    const sessions = await import('../src/agent/sessions.js');
    expect((await sessions.list()).map((x) => x.id)).toEqual(['s_old']);
  });

  it('全新安装（没有旧库）：直接建好所有表', async () => {
    const store = await import('../src/agent/store.js');
    await store.collection('fileVersions').put({ id: 'x', path: 'a' });
    const db = await req(indexedDB.open('jarvis'));
    expect(db.version).toBe(5);
    expect([...db.objectStoreNames].sort()).toEqual([...store.STORES].sort());
    db.close();
  });

  it('另一个标签页还开着旧版、挡住了升级：不迁移、不丢数据，提示用户关掉旧页面', async () => {
    const old = await makeOldDb(4, OLD_DATA, { keepOpen: true }); // 旧版代码不会主动让路
    const store = await import('../src/agent/store.js');
    expect(await store.storageProblem()).toMatch(/另一个未央页面还开着旧版本/);
    // 旧页面关掉后，刷新：正常升级，数据都在
    old.close();
    vi.resetModules();
    const store2 = await import('../src/agent/store.js');
    expect(await store2.storageProblem()).toBe('');
    expect((await store2.collection('sessions').get('s_old')).title).toBe('杭州三日游');
    expect(await store2.collection('files').get('notes/计划.md')).toBeTruthy();
  });

  it('新版本的页面打开时，这一版的页面主动让路，不挡住以后的升级', async () => {
    const store = await import('../src/agent/store.js');
    await store.collection('kv').put({ id: 'a', v: 1 });
    // 以后的 v6 来升级
    const next = indexedDB.open('jarvis', 6);
    let blocked = false;
    next.onblocked = () => { blocked = true; };
    next.onupgradeneeded = () => next.result.createObjectStore('future', { keyPath: 'id' });
    const db6 = await req(next);
    expect(blocked).toBe(false);
    db6.close();
    // 这一版的页面之后再用：按现有（更高的）版本打开，数据还在
    expect((await store.collection('kv').get('a')).v).toBe(1);
  });
});
