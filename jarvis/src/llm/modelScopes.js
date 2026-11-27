import { serverModelPreview } from '../core/serverModelPreview.js';
/** 本机与服务器严格分库；完整掩码配置只存内存，持久化预览不能用于写回。 */
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

export function createModelScopes({ getLocal, saveLocal, getClient, onServerSaved = () => {}, storage, now }) {
  let serverConfig = null;
  let identity = '';
  let pending = null;
  const preview = serverModelPreview({ storage, now });
  let writeQueue = Promise.resolve();
  let revision = 0;
  const missing = () => Object.assign(new Error('请先在设置中登录云服务器'), { kind: 'api', code: 'SERVER_NOT_CONNECTED' });
  const clientKey = client => client ? JSON.stringify([client.base || '', client.account?.userId || '', client.account?.token || '']) : '';
  const clientNow = () => {
    const client = getClient();
    const key = clientKey(client);
    if (identity !== key) { identity = key; serverConfig = null; pending = null; revision++; }
    return client;
  };
  const ensure = client => {
    // 比较执行该请求的真实客户端身份。仅服务端认证成功的旧登录换发会更新它；
    // 不能把正常换发误判成切账号，真正换账号时旧客户端仍保留原凭证。
    if (clientKey(clientNow()) !== clientKey(client)) throw Object.assign(new Error('服务器账号已切换，请重新打开模型设置'), { code: 'SERVER_SCOPE_CHANGED', kind: 'api' });
  };
  return {
    get(scope) {
      if (scope !== 'server') return getLocal();
      clientNow();
      return serverConfig;
    },
    preview(scope) {
      return scope === 'server' ? preview.read(clientNow()) : getLocal();
    },
    async refresh(scope) {
      if (scope !== 'server') return getLocal();
      const client = clientNow();
      if (!client) throw missing();
      if (pending) return pending;
      const read = async () => {
        await writeQueue.catch(() => {});
        ensure(client);
        const current = revision;
        const loaded = await client.getConfig();
        const unchanged = current === revision;
        ensure(client);
        if (unchanged) { serverConfig = loaded; preview.save(client, loaded); }
        return serverConfig;
      };
      const reading = read();
      pending = reading;
      try { return await reading; }
      finally { if (pending === reading) pending = null; }
    },
    patch(scope, update) {
      if (scope !== 'server') return Promise.resolve(saveLocal(update(getLocal())));
      const client = clientNow();
      const run = async () => {
        if (!client) throw missing();
        ensure(client);
        revision++;
        // 每次写前读当前配置，防止另一台设备刚换的型号被旧快照覆盖。
        const before = await client.getConfig();
        ensure(client);
        if (before.readOnly) throw Object.assign(new Error('当前使用管理员共享模型；模型设置由管理员维护'), { status: 403, code: 'SHARED_MODELS' });
        const after = update(before);
        ensure(client);
        const delta = configDelta(before, after);
        if (Object.keys(delta).length) await client.putConfig(delta);
        ensure(client);
        const confirmed = await client.getConfig();
        ensure(client);
        for (const [id, key] of Object.entries(delta.keys || {})) {
          if (typeof key !== 'string' || !key.trim() || key.startsWith('••••')) continue;
          if (confirmed.keys?.[id] !== `••••${key.trim().slice(-4)}`)
            throw Object.assign(new Error('云服务器Key读回核对不一致，未确认保存；请刷新后重试'), { code: 'MODEL_KEY_SAVE' });
        }
        const searchKey = delta.openaiSearchKey;
        if (typeof searchKey === 'string' && searchKey.trim() && !searchKey.startsWith('••••') && confirmed.openaiSearchKey !== `••••${searchKey.trim().slice(-4)}`)
          throw Object.assign(new Error('云服务器搜索Key读回核对不一致，未确认保存；请刷新后重试'), { code: 'MODEL_KEY_SAVE' });
        serverConfig = confirmed;
        preview.save(client, confirmed);
        onServerSaved(serverConfig);
        return serverConfig;
      };
      const result = writeQueue.then(run, run);
      writeQueue = result.then(
        () => {},
        () => {}
      );
      return result;
    }
  };
}
