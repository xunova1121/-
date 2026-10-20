/** 本机与服务器严格分库；服务端只存内存中的掩码快照，写操作串行且仅发送改动字段。 */
export function configDelta(before, after) {
  const delta = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) === JSON.stringify(before[key])) continue;
    if (['models', 'keys', 'baseURLs', 'providerNames', 'modelLists'].includes(key)) {
      delta[key] = Object.fromEntries(Object.entries(value || {}).filter(([id, item]) => JSON.stringify(item) !== JSON.stringify(before[key]?.[id])));
    } else delta[key] = value;
  }
  return delta;
}

export function createModelScopes({ getLocal, saveLocal, getClient, onServerSaved = () => {} }) {
  let serverConfig = null;
  let writeQueue = Promise.resolve();
  const missing = () => Object.assign(new Error('请先在设置中登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
  return {
    get(scope) { return scope === 'server' ? serverConfig : getLocal(); },
    async refresh(scope) {
      if (scope !== 'server') return getLocal();
      const client = getClient();
      if (!client) throw missing();
      await writeQueue.catch(() => {});
      serverConfig = await client.getConfig();
      return serverConfig;
    },
    patch(scope, update) {
      if (scope !== 'server') return Promise.resolve(saveLocal(update(getLocal())));
      const run = async () => {
        const client = getClient();
        if (!client) throw missing();
        // 每次写前读当前配置，防止另一台设备刚换的型号被旧快照覆盖。
        const before = await client.getConfig();
        const after = update(before);
        const delta = configDelta(before, after);
        if (Object.keys(delta).length) await client.putConfig(delta);
        serverConfig = await client.getConfig();
        onServerSaved(serverConfig);
        return serverConfig;
      };
      const result = writeQueue.then(run, run);
      writeQueue = result.then(() => {}, () => {});
      return result;
    }
  };
}
