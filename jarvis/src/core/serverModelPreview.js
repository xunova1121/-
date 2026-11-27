import { favoriteLines, lineValid } from '../llm/modelLibrary.js';

const KEY = 'jarvis.server.model-preview.v1';
const MAX_CHARS = 32000;
const TTL = 24 * 60 * 60_000;
const short = value => typeof value === 'string' ? value.slice(0, 200) : '';

/** 仅用于选模型的文字预览；不存URL、Key、Token、搜索配置或服务商完整目录。 */
export function modelPreview(config) {
  const lines = favoriteLines(config).slice(0, 24);
  const providers = [...new Set([config.provider, ...lines.map(line => line.provider)])].slice(0, 25);
  return {
    provider: short(config.provider),
    pinModel: Boolean(config.pinModel),
    readOnly: Boolean(config.readOnly),
    models: Object.fromEntries(providers.map(id => [id, short(config.models?.[id])])),
    providerNames: Object.fromEntries(providers.map(id => [id, short(config.providerNames?.[id])])),
    favoriteModels: lines,
    abilities: Object.fromEntries(Object.entries(config.abilities || {}).slice(0, 8).map(([ability, routes]) => [short(ability), {
      main: lineValid(routes?.main) ? { provider: routes.main.provider, model: short(routes.main.model) } : null,
      backup: lineValid(routes?.backup) ? { provider: routes.backup.provider, model: short(routes.backup.model) } : null
    }]))
  };
}

function identity(client) {
  const userId = client?.account?.userId;
  if (!(userId === 'owner' || /^u_[a-f0-9]{24}$/.test(userId || '')) || client?.account?.role === 'evaluation' || typeof client?.base !== 'string') return null;
  return { server: client.base.replace(/\/+$/, ''), userId };
}

/** 全设备只留最近一个账号的一份预览，最多32000字符/24小时；旧无身份登录不落盘。 */
export function serverModelPreview({ storage = globalThis.localStorage, now = Date.now } = {}) {
  return {
    read(client) {
      const who = identity(client);
      if (!who) return null;
      try {
        const raw = storage?.getItem(KEY);
        if (!raw || raw.length > MAX_CHARS) return null;
        const saved = JSON.parse(raw);
        if (saved.server !== who.server || saved.userId !== who.userId || !Number.isFinite(saved.at) || now() - saved.at < 0 || now() - saved.at > TTL) return null;
        return modelPreview(saved.config);
      } catch { return null; /* 存储受限或旧缓存损坏时照常联网。 */ }
    },
    save(client, config) {
      const who = identity(client);
      if (!who) return;
      try {
        const raw = JSON.stringify({ ...who, at: now(), config: modelPreview(config) });
        if (raw.length <= MAX_CHARS) storage?.setItem(KEY, raw);
      } catch { /* 预览不能影响服务器配置的读写结果。 */ }
    }
  };
}
