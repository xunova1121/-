/** 共享设备切换成员后，缓存和本地附件跟随身份；原主人数据保持原位置。 */
export function userStorageSuffix(storage) {
  try {
    storage ??= globalThis.localStorage;
    const account = JSON.parse(storage?.getItem('jarvis.server.v1') || '{}');
    if (/^u_[a-f0-9]{24}$/.test(account.userId || '')) return ':user:' + encodeURIComponent(account.url || '') + ':' + account.userId;
  } catch { /* 旧登录没有成员ID，保持原主人缓存。 */ }
  return '';
}
export function privateStorage(storage = globalThis.localStorage) {
  if (!storage) return null;
  const suffix = userStorageSuffix(storage);
  const key = name => /^(jarvis\.server\.v1|jarvis\.server\.device\.v1)$/.test(name) ? name : name + suffix;
  return {
    getItem: name => storage.getItem(key(name)),
    setItem: (name, value) => storage.setItem(key(name), value),
    removeItem: name => storage.removeItem(key(name))
  };
}
