import { providerById } from '../../shared/providers.js';
/** 声音选择不依赖聊天 SDK，便于独立检查手机实际选择的服务。 */
export function selectVoiceEngine(cfg, gateway = null) {
  const voice = cfg.voice || {engine:'auto'};
  if (voice.engine && voice.engine !== 'auto') return voice.engine;
  const has = id => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  const p = providerById(cfg.provider);
  const providerVoice = ['multi','openai'].includes(p?.kind) && has(p.id) && (!p.custom || cfg.baseURLs?.[p.id]);
  return has('azure-speech') && voice.azureRegion ? 'azure' : has('elevenlabs') ? 'elevenlabs' : has('openai') ? 'openai' : gateway && has('siliconflow') ? 'siliconflow' : globalThis.__jarvisEdgeSpeech || gateway ? 'edge' : providerVoice ? 'provider' : 'browser';
}
