import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';

let source, records, collection;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  ({ collection } = await import('../src/agent/store.js'));
  records = collection('sessions');
  ({ sidebarSource: source } = await import('../src/agent/sessions.js'));
  await collection('kv').put({id: 'unrelated', value: '保留'});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 另一连接直接写 v5 表，模拟升级前保存的会话。
async function writeLegacy(rows) {
  const db = await new Promise(resolve => {
    const open = indexedDB.open('jarvis');
    open.onsuccess = () => resolve(open.result);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    for (const row of rows) tx.objectStore('sessions').put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

it('四条标题和查看更多按置顶/时间排列，升级后重复刷新不再读取历史正文', async () => {
  const messages = [{role: 'assistant', content: '旧消息'.repeat(40000)}];
  await writeLegacy(Array.from({length: 12}, (_, i) => ({id: 'c' + i, title: '对话' + i, messages, updatedAt:i, pinned:i === 1})));
  const fullReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  const oneReads = vi.spyOn(IDBObjectStore.prototype, 'get');
  const list = await source().list();
  expect(list.map(row => row.id)).toEqual(['c1','c11','c10','c9','c8']);
  const sessionReads = spy => spy.mock.contexts.filter(store => store.name === 'sessions').length;
  expect(sessionReads(fullReads)).toBe(0);
  expect(sessionReads(oneReads)).toBe(12);
  oneReads.mockClear();
  expect(await source().list()).toEqual(list);
  expect(sessionReads(fullReads) + sessionReads(oneReads)).toBe(0);
  expect(JSON.stringify(list)).not.toContain('旧消息');
  await writeLegacy([{id:'late',title:'旧窗口新对话',updatedAt:130,messages}]);
  expect((await source().list())[1].id).toBe('late');
  expect(sessionReads(oneReads)).toBe(1);
});

it('改名、置顶、评测、删除、还原与清空跟随原件，其他 kv 完整保留', async () => {
  const { rename, setPinned, trash, restore } = await import('../src/agent/sessions.js');
  const a = { id:'a',title:'甲',updatedAt:2,messages:[{role:'user',content:'你好',ts:1}] };
  const b = { ...a,id:'b',title:'乙',updatedAt:3 };
  await Promise.all([records.put(a),records.put(b),records.put({...a,id:'e',evaluationId:'test',updatedAt:20})]);
  await rename('a', '甲改名');
  await setPinned('a', true);
  expect((await source().list()).map(row => row.title)).toEqual(['甲改名','乙']);
  await trash('a');
  expect((await source().list()).map(row => row.id)).toEqual(['b']);
  await restore('a');
  expect((await source().list()).map(row => row.id)).toEqual(['a','b']);
  await records.clear();
  expect(await source().list()).toEqual([]);
  expect(await collection('kv').get('unrelated')).toEqual({id:'unrelated',value:'保留'});
  expect((await collection('kv').all()).some(row => row.id.startsWith('session-list-row:'))).toBe(false);
});

it('另一窗口并发改名时，旧记录补索引不会覆盖新标题', async () => {
  const rows = Array.from({length: 34}, (_, id) => ({id: 'c' + id, title: '旧名' + id, updatedAt: id, messages: []}));
  await writeLegacy(rows);
  const previousWindow = source();
  vi.resetModules();
  const { collection: otherConnection } = await import('../src/agent/store.js');
  const otherRecords = otherConnection('sessions');
  await Promise.all([previousWindow.list(), otherRecords.put({...rows[0], title: '新标题', pinned: true})]);
  expect((await previousWindow.list())[0]).toMatchObject({ id: 'c0', title: '新标题' });
  await otherRecords.delete('c0');
  expect((await previousWindow.list()).map(row => row.id)).not.toContain('c0');
});
