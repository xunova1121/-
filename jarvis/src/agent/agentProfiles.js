import { collection } from './store.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { BUILTIN_AGENTS, ALL_BUILTIN_AGENTS } from './agentProfileBuiltins.js';
import { profileError, profileFilter, profileId, validateProfile } from './agentProfileValidation.js';
export { BUILTIN_AGENTS, ALL_BUILTIN_AGENTS, validateProfile };

// 使用现有kv集合，不升级数据库、不改旧对话。100份×32KiB限制配置的总规模。
export const MAX_USER_AGENTS = 100;
export const PROFILE_STORE_KEY = 'agent-profiles.v1';
const kv = collection('kv');
const pending = new WeakMap();
const builtinIds = new Set(ALL_BUILTIN_AGENTS.map(p => p.id));
const originalBuiltinIds = new Set(BUILTIN_AGENTS.map(p => p.id));
const clone = value => structuredClone(value);

function serial(store, work) {
  const key = store.scopeKey || store;
  const previous = pending.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    // 浏览器多个标签页也不能把同一索引的新增互相覆盖；服务器由身份范围的队列串行。
    const locks = !store.scopeKey && globalThis.navigator?.locks;
    return locks?.request ? locks.request('weiyang-agent-profiles' + userStorageSuffix(), work) : work();
  });
  pending.set(key, next);
  next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
  return next;
}

async function readProfiles(store) {
  const record = await store.get(PROFILE_STORE_KEY);
  if (!record) return [];
  if (record.version !== 1 || !Array.isArray(record.items) || record.items.length > MAX_USER_AGENTS) throw profileError('storage', '智能体存储格式异常，原数据未覆盖');
  // 新增内置ID不能使升级前恰好同ID的个人配置整库无法读取；原8项仍保留。
  const ids = [...originalBuiltinIds];
  return record.items.map(value => {
    const profile = validateProfile(value, { existingIds: ids });
    if (profile.source === 'builtin') throw profileError('source', '个人存储不能声明为内置智能体');
    ids.push(profile.id);
    return profile;
  });
}

/** 每次操作绑定当前存储身份，异步写入不会随另一个成员的请求切换。 */
export function createAgentRegistry(storage = kv) {
  const bind = () => storage.bind?.() || storage;
  const writable = id => { profileId(id); if (originalBuiltinIds.has(id)) throw profileError('id', '内置智能体不可覆盖或删除', 409); };
  const write = work => {
    const store = bind();
    return serial(store, async () => {
      const items = await readProfiles(store);
      const result = work(items);
      await store.put({ id: PROFILE_STORE_KEY, version: 1, items });
      return clone(result);
    });
  };
  return {
    async listAgents(options = {}) {
      const { category, query } = profileFilter(options);
      const personal = await readProfiles(bind());
      const items = [...ALL_BUILTIN_AGENTS.filter(p => !personal.some(row => row.id === p.id)), ...personal];
      return clone(items.filter(p => (!category || (category === 'mine' ? p.source !== 'builtin' : p.category === category))
        && (!query || `${p.name}\n${p.intro}\n${p.starters.join('\n')}`.toLocaleLowerCase().includes(query))));
    },
    async getAgent(id) {
      profileId(id);
      const builtin = ALL_BUILTIN_AGENTS.find(p => p.id === id);
      if (originalBuiltinIds.has(id)) return clone(builtin);
      return clone((await readProfiles(bind())).find(p => p.id === id) || builtin || null);
    },
    createAgent(value) {
      const profile = validateProfile(value, { existingIds: builtinIds });
      if (profile.source === 'builtin') throw profileError('source', '不能新建内置智能体');
      return write(items => {
        validateProfile(profile, { existingIds: items.map(p => p.id) });
        if (items.length >= MAX_USER_AGENTS) throw profileError('profiles', `最多保存${MAX_USER_AGENTS}份个人智能体`, 409);
        items.push(profile);
        return profile;
      });
    },
    updateAgent(id, value) {
      writable(id);
      const profile = validateProfile(value);
      if (profile.id !== id) throw profileError('id', '须与更新目标一致');
      if (profile.source === 'builtin') throw profileError('source', '不能更改为内置智能体');
      return write(items => {
        const index = items.findIndex(p => p.id === id);
        if (index < 0 && builtinIds.has(id)) throw profileError('id', '内置智能体不可覆盖或删除', 409);
        if (index < 0) throw profileError('id', '没有找到此智能体', 404);
        if (items[index].source !== profile.source) throw profileError('source', '不能更改已有智能体的来源');
        items[index] = profile;
        return profile;
      });
    },
    removeAgent(id) {
      writable(id);
      return write(items => {
        const index = items.findIndex(p => p.id === id);
        if (index < 0 && builtinIds.has(id)) throw profileError('id', '内置智能体不可覆盖或删除', 409);
        if (index < 0) throw profileError('id', '没有找到此智能体', 404);
        items.splice(index, 1);
        return { ok: true };
      });
    }
  };
}

const local = createAgentRegistry();
let remote = null;
/** 与会话同一路径切换；远端失败直接报错，绝不悄悄写回本机或读取别人的缓存。 */
export function useRemote(value) { remote = value; }
export const listAgents = options => (remote || local).listAgents(options);
export const getAgent = id => (remote || local).getAgent(id);
export const createAgent = value => (remote || local).createAgent(value);
export const updateAgent = (id, value) => (remote || local).updateAgent(id, value);
export const removeAgent = id => (remote || local).removeAgent(id);
