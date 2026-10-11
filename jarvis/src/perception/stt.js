/**
 * 云端语音识别：本地 VAD 切出一句话 → 编码成 16 kHz WAV → 上传转写。
 * 桌面版（Electron）没有浏览器自带的语音识别，靠它实现直接对话和唤醒词；网页版也可以选用（不依赖 Google 服务）。
 */
import { customViaGateway } from '../../shared/providers.js';

export const STT_ENGINES = [
  { id: 'browser', name: '浏览器自带（Chrome / Edge，需联网）' },
  { id: 'siliconflow', name: '硅基流动 SenseVoice（中文快且便宜）', keyFrom: 'siliconflow', model: 'FunAudioLLM/SenseVoiceSmall', base: 'https://api.siliconflow.cn/v1', browser: false },
  { id: 'openai', name: 'OpenAI 语音转写', keyFrom: 'openai', model: 'gpt-4o-mini-transcribe', base: 'https://api.openai.com/v1', browser: true },
  { id: 'custom', name: '自定义（OpenAI 兼容 /audio/transcriptions）', keyFrom: 'stt-custom', custom: true, browser: true }
];
export const sttEngineById = (id) => STT_ENGINES.find((e) => e.id === id);

/**
 * 实际使用的识别引擎。auto：网页版有浏览器识别就用；否则按已有密钥选云端；都没有返回 none。
 * @param {object} cfg 模型配置（含 keys、stt）
 * @param {{ gateway?: object|null, browserSupported: boolean }} env
 */
export function resolveStt(cfg, { gateway = null, browserSupported }) {
  const want = cfg.stt?.engine || 'auto';
  if (want !== 'auto') return want === 'browser' && !browserSupported ? 'none' : want;
  if (browserSupported) return 'browser';
  const has = (id) => Boolean(cfg.keys?.[id]) || Boolean(gateway?.keys?.includes(id));
  if (has('siliconflow') && gateway) return 'siliconflow';
  if (has('openai')) return 'openai';
  if (has('siliconflow')) return 'siliconflow';
  return 'none';
}

/** Float32 PCM → 16 位单声道 WAV */
export function encodeWav(samples, sampleRate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 去掉 SenseVoice 一类模型输出的语言 / 情绪 / 事件标签 */
export const cleanTranscript = (t) => String(t || '').replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();

/**
 * @param {string} engineId
 * @param {object} cfg 模型配置
 * @param {Blob} audio
 * @param {{ gateway?: object|null, signal?: AbortSignal, fetchImpl?: typeof fetch }} o
 */
export async function transcribe(engineId, cfg, audio, { gateway = null, signal, fetchImpl = globalThis.fetch } = {}) {
  const e = sttEngineById(engineId);
  if (!e || e.id === 'browser') throw new Error('不是云端识别引擎');
  const key = cfg.keys?.[e.keyFrom] || '';
  const customURL = cfg.stt?.customURL || '';
  const viaGateway = e.custom ? customViaGateway(gateway, customURL) : Boolean(gateway);
  if (!key && !e.custom && !(gateway?.keys?.includes(e.keyFrom))) throw new Error(`语音识别需要 ${e.name} 的 API Key（在“模型”面板填写）`);
  if (e.custom && !customURL) throw new Error('请填写自定义语音识别地址');
  const base = viaGateway ? `${gateway.origin}/api/llm/${e.id}` : e.custom ? customURL.replace(/\/$/, '') : e.base;
  const form = new FormData();
  form.append('file', audio, 'speech.wav');
  form.append('model', e.custom ? (cfg.stt?.customModel || 'whisper-1') : e.model);
  if (e.id !== 'siliconflow') form.append('language', 'zh');
  const headers = {};
  if (key || viaGateway) headers.authorization = `Bearer ${key || 'use-gateway-key'}`;
  if (e.custom && viaGateway) headers['x-jarvis-upstream'] = customURL.trim();
  const res = await fetchImpl(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form, signal });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg += ` ${j.error?.message || j.message || ''}`; } catch { /* 非 JSON */ }
    throw new Error(`语音识别失败：${msg.trim()}`);
  }
  const j = await res.json().catch(() => ({}));
  return cleanTranscript(j.text);
}
