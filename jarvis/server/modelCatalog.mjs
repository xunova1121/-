/** 只在已登录服务器上读取已保存线路；密钥留在服务器，不回传手机。 */
import { ENV_KEYS, providerById } from '../shared/providers.js';
import { fetchModelCatalog } from '../src/llm/modelCatalog.js';

export async function serverModelCatalog(cfg, provider, signal) {
  if (!providerById(provider)) throw Object.assign(new Error('未知服务商'), { status: 400, code: 'INVALID_PROVIDER', kind: 'api' });
  const key = cfg.keys?.[provider] || process.env[ENV_KEYS[provider]] || '';
  return fetchModelCatalog({ ...cfg, provider, keys: { ...cfg.keys, [provider]: key } }, { signal });
}
