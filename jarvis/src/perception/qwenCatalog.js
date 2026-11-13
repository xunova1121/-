import { loadServerSettings, normalizeUrl } from '../core/serverClient.js';
import { QWEN_VOICE_SOURCE, QWEN_VOICE_MODEL, normalizeQwenVoices, parseQwenVoiceCatalog } from '../../shared/qwenVoiceCatalog.js';
import { webBody } from '../agent/webBody.js';

export function savedQwenCatalog(value, now = Date.now()) {
  if (!value || value.model !== QWEN_VOICE_MODEL || value.source !== QWEN_VOICE_SOURCE || !Number.isFinite(value.fetchedAt) || now - value.fetchedAt > 7 * 86400000 || value.fetchedAt > now + 60000) return null;
  try { return { model: QWEN_VOICE_MODEL, source: QWEN_VOICE_SOURCE, fetchedAt: value.fetchedAt, voices: normalizeQwenVoices(value.voices) }; } catch { return null; }
}

/** 令牌只发给已配置的未央服务器；直读固定官方文档时不发Key、Cookie或令牌。 */
export async function fetchQwenCatalog({ gateway = null, remote = loadServerSettings(), signal, fetchImpl = globalThis.fetch } = {}) {
  const base = gateway?.origin || (remote.enabled && remote.token ? remote.url : '');
  let response;
  if (base) {
    const authorized = remote.enabled && remote.token && normalizeUrl(base) === normalizeUrl(remote.url);
    response = await fetchImpl(new URL('/api/voice/qwen/voices?refresh=1&model=' + QWEN_VOICE_MODEL, base).href, {
      signal, credentials: 'omit', cache: 'no-store', headers: authorized ? { Authorization: 'Bearer ' + remote.token } : { 'x-jarvis-client': '1' }
    });
    if (!response.ok) throw Object.assign(new Error('目录刷新失败，请检查网关/服务器版本及登录状态；已有声音仍可选择'), { code: 'QWEN_VOICE_FETCH', status: response.status, kind: 'api' });
    const bytes = await webBody(response, 100000, signal);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const saved = savedQwenCatalog(data);
    if (!saved) throw Object.assign(new Error('返回的音色目录不属于当前实时模型'), { code: 'QWEN_VOICE_CATALOG', kind: 'api' });
    return saved;
  }
  response = await fetchImpl(QWEN_VOICE_SOURCE, { signal, credentials: 'omit', headers: { Accept: 'text/html' }, redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('官方音色目录暂时无法连接，保留已有声音'), { code: 'QWEN_VOICE_FETCH', status: response.status, kind: 'api' });
  const bytes = await webBody(response, 2000000, signal);
  return { ...parseQwenVoiceCatalog(new TextDecoder().decode(bytes)), fetchedAt: Date.now() };
}
