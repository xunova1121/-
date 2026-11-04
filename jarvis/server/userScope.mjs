/** 身份仅由服务器鉴权结果设置；异步任务、定时器和延迟写盘继承自己的用户。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { createFileStore } from './fileStore.mjs';

const context = new AsyncLocalStorage();
export const PRIMARY_USER = 'owner';
export const currentUser = () => context.getStore() || PRIMARY_USER;
export function runAsUser(userId, work) {
  if (userId !== PRIMARY_USER && !/^u_[a-f0-9]{24}$/.test(userId || '')) throw Object.assign(new Error('用户身份无效'), { status: 403 });
  return context.run(userId, work);
}
export const userDataDir = (root, userId = currentUser()) => userId === PRIMARY_USER ? root : path.join(root, 'users', userId);

export function createUserStore(dataDir) {
  // 身份最多50个，由安全管理入口限制；不淘汰仍有延迟写盘的后端。
  const stores = new Map();
  const selected = () => {
    const id = currentUser();
    if (!stores.has(id)) stores.set(id, createFileStore(path.join(userDataDir(dataDir, id), 'store')));
    return stores.get(id);
  };
  return {
    dir: path.join(dataDir, 'store'), scoped: selected,
    all: name => selected().all(name), get: (name, id) => selected().get(name, id),
    put: (name, row) => selected().put(name, row), delete: (name, id) => selected().delete(name, id),
    clear: name => selected().clear(name)
  };
}

/** 路由和执行器共享代理，实际对象及内部缓存按用户创建。 */
export function userService(factory) {
  const services = new Map();
  const selected = () => {
    const id = currentUser();
    if (!services.has(id)) services.set(id, factory(id));
    return services.get(id);
  };
  return new Proxy({}, { get(_target, key) {
    const service = selected(), value = service[key];
    return typeof value === 'function' ? value.bind(service) : value;
  } });
}
