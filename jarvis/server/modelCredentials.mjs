import { PROVIDERS } from '../shared/providers.js';
import { CREDENTIAL_CONTEXT, usableModelKey } from '../src/llm/credentialContext.js';

/** 只在运行时读取已注入的环境变量；不读写jarvis.env，不把备用Key落盘。 */
export function serverModelConfig(saved, env = process.env) {
  const keys = { ...saved.keys };
  const sources = {};
  for (const p of PROVIDERS) {
    const own = usableModelKey(keys[p.id]);
    let openrouter = p.id === 'openrouter';
    try { openrouter ||= p.custom && new URL(saved.baseURLs?.[p.id]).origin === 'https://openrouter.ai'; } catch { /* 非OpenRouter地址不借用它的环境密钥。 */ }
    const fallback = openrouter ? usableModelKey(env.OPENROUTER_API_KEY) : '';
    keys[p.id] = own || fallback;
    sources[p.id] = own ? '云服务器设置' : fallback ? '环境变量 OPENROUTER_API_KEY' : '没有 Key';
  }
  return { ...saved, keys, [CREDENTIAL_CONTEXT]: sources };
}
