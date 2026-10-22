import { ttsEngineById } from './tts.js';
/**
 * 声音选择不依赖聊天 SDK，便于独立检查手机实际选择的服务。
 * 只有三种：百炼实时（有百炼密钥时）→ 免费在线声音（安卓插件或本机网关可用时）→ 系统自带。
 * 以前选过、现在已去掉的引擎（Azure、ElevenLabs……）按“自动”处理。
 */
export function selectVoiceEngine(cfg, gateway = null) {
  const voice = cfg.voice || { engine: 'auto' };
  if (voice.engine && voice.engine !== 'auto' && ttsEngineById(voice.engine)) return voice.engine;
  const has = (id) => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  if (has('qwen') && (globalThis.__jarvisQwenSocket || gateway)) return 'qwen-realtime';
  return globalThis.__jarvisEdgeSpeech || gateway ? 'edge' : 'browser';
}
