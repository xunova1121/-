import { QWEN_VOICE_SOURCE, QWEN_VOICE_MODEL, parseQwenVoiceCatalog } from '../shared/qwenVoiceCatalog.js';
import { webBody } from '../src/agent/webBody.js';

/** 固定官方文档目标，不使用模型密钥。只缓存一份目录，24小时有效，刷新最短间隔1分钟。 */
export function createQwenVoiceCatalog({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  let pending = null;
  return async ({ refresh = false } = {}) => {
    if (cached && now() - cached.fetchedAt < (refresh ? 60000 : 86400000)) return cached;
    if (pending) return pending;
    pending = (async () => {
      const signal = AbortSignal.timeout(10000);
      const response = await fetchImpl(QWEN_VOICE_SOURCE, { signal, headers: { Accept: 'text/html' }, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw Object.assign(new Error('无法读取官方音色目录'), { code: 'QWEN_VOICE_FETCH', status: response.status, kind: 'api' });
      const bytes = await webBody(response, 2000000, signal);
      const parsed = parseQwenVoiceCatalog(new TextDecoder().decode(bytes));
      cached = { ...parsed, fetchedAt: now() };
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
}
export const qwenVoiceModel = QWEN_VOICE_MODEL;
