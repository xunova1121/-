import { QWEN_BUILTIN_VOICES } from './qwenVoices.js';
import { normalizeQwenVoices } from './qwenVoiceCatalog.js';

/** 百炼官方实时协议；地址固定，不能把网关变成任意 WebSocket 代理。 */
export const QWEN_ASR = 'qwen3-asr-flash-realtime';
export const QWEN_TTS = 'qwen3-tts-flash-realtime';
export const QWEN_VOICES = QWEN_BUILTIN_VOICES;
// 内置48条加刷新目录最多200条，校验集合最多248条，不接受任意音色ID。
const availableVoices = new Set(QWEN_VOICES.map(([id]) => id));
export function registerQwenVoices(voices) {
  const normalized = normalizeQwenVoices(voices);
  availableVoices.clear();
  for (const [id] of [...QWEN_VOICES, ...normalized]) availableVoices.add(id);
  return normalized;
}
export const QWEN_EVENTS = new Set(['session.update','session.finish','input_audio_buffer.append','input_audio_buffer.commit','input_audio_buffer.clear','input_text_buffer.append','input_text_buffer.commit','input_text_buffer.clear']);
export function qwenUrl(model, region = 'beijing') {
  if (![QWEN_ASR,QWEN_TTS].includes(model)) throw new Error('不支持的百炼实时模型');
  if (!['beijing','singapore'].includes(region)) throw new Error('百炼地域不正确');
  return 'wss://' + (region === 'beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com') + '/api-ws/v1/realtime?model=' + model;
}
export function qwenSettings(model, { voice = 'Bella', silenceMs = 800 } = {}) {
  if (model === QWEN_ASR) return { input_audio_format:'pcm',sample_rate:16000,input_audio_transcription:{language:'zh'},turn_detection:{type:'server_vad',threshold:0.2,silence_duration_ms:Math.max(400,Math.min(2000,silenceMs))} };
  if (model !== QWEN_TTS || !availableVoices.has(voice)) throw new Error('百炼实时音色不正确');
  return { voice,mode:'commit',language_type:'Chinese',response_format:'pcm',sample_rate:24000 };
}
