import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createAgentProfileClient } from '../src/core/agentProfileClient.js';

beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => vi.unstubAllGlobals());

it('本机配置随IndexedDB持久化，不升级数据库，不改旧会话和记忆', async () => {
  const { collection, STORES } = await import('../src/agent/store.js');
  await collection('sessions').put({ id: 'old', title: '原对话', messages: [] });
  await collection('kv').put({ id: 'core', human: '原记忆' });
  let profiles = await import('../src/agent/agentProfiles.js');
  const value = { ...structuredClone(profiles.BUILTIN_AGENTS[0]), id: 'local-ppt', source: 'user' };
  await profiles.createAgent(value);
  vi.resetModules();
  profiles = await import('../src/agent/agentProfiles.js');
  expect(await profiles.getAgent('local-ppt')).toEqual(value);
  expect(await collection('sessions').get('old')).toMatchObject({ title: '原对话' });
  expect(await collection('kv').get('core')).toMatchObject({ human: '原记忆' });
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('jarvis'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  expect(db.version).toBe(5);
  expect([...db.objectStoreNames].sort()).toEqual([...STORES].sort());
  db.close();
});

it('本机存储按成员身份分库，切回主人仍能读到原来的配置', async () => {
  let account = {};
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(account) });
  const load = async () => { vi.resetModules(); return import('../src/agent/agentProfiles.js'); };
  let profiles = await load();
  await profiles.createAgent({ ...structuredClone(profiles.BUILTIN_AGENTS[0]), id: 'private-one', source: 'user', name: '主人配置' });
  account = { userId: 'u_' + 'a'.repeat(24), url: 'https://fixture.invalid' };
  profiles = await load();
  expect(await profiles.getAgent('private-one')).toBeNull();
  await profiles.createAgent({ ...structuredClone(profiles.BUILTIN_AGENTS[0]), id: 'private-one', source: 'user', name: '成员配置' });
  account = {};
  profiles = await load();
  expect((await profiles.getAgent('private-one')).name).toBe('主人配置');
});

it('旧服务器404、鉴权错误和停止保持报错，只有明确不存在的配置返回null', async () => {
  const request = vi.fn();
  const client = createAgentProfileClient(request);
  for (const error of [Object.assign(new Error('旧服务器没有此接口'), { status: 404 }), Object.assign(new Error('登录失效'), { status: 401 }), Object.assign(new Error('停止'), { name: 'AbortError' })]) {
    request.mockRejectedValueOnce(error);
    await expect(client.getAgent('my-agent')).rejects.toBe(error);
  }
  request.mockRejectedValueOnce({ status: 404, code: 'AGENT_PROFILE_NOT_FOUND' });
  expect(await client.getAgent('missing')).toBeNull();
  request.mockResolvedValue([]);
  await client.listAgents({ query: '甲&乙', category: 'office' });
  expect(request).toHaveBeenLastCalledWith('/api/agent-profiles?category=office&query=%E7%94%B2%26%E4%B9%99');
});
