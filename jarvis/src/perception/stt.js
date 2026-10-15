/**
 * 云端语音识别：本地 VAD 切出一句话 → 编码成 16 kHz WAV → 上传转写。
 * 桌面版（Electron）没有浏览器自带的语音识别，靠它实现直接对话和唤醒词；网页版也可以选用（不依赖 Google 服务）。
 */
import { customViaGateway, providerById, upstreamFor } from '../../shared/providers.js';

export const STT_ENGINES = [
  { id: 'browser', name: '浏览器自带（Chrome / Edge，需联网）' },
  { id: 'siliconflow', name: '硅基流动 SenseVoice（中文快且便宜）', keyFrom: 'siliconflow', model: 'FunAudioLLM/SenseVoiceSmall', base: 'https://api.siliconflow.cn/v1', browser: false },
  { id: 'openai', name: 'OpenAI 语音转写', keyFrom: 'openai', model: 'gpt-4o-mini-transcribe', base: 'https://api.openai.com/v1', browser: true },
  { id: 'custom', name: '自定义（OpenAI 兼容 /audio/transcriptions）', keyFrom: 'stt-custom', custom: true, browser: true },
  { id: 'provider', name: '用当前模型服务商转写（不用另配密钥，需服务商支持）', fromProvider: true, browser: true }
];
/** 用模型服务商转写时依次尝试的模型；试成功的记住 */
export const PROVIDER_STT_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1', 'gpt-4o-transcribe'];
const workingModel = new Map(); // baseURL → 模型
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
  // 都没有：试试当前的模型服务商（中转平台大多也提供 OpenAI 兼容的语音转写）
  const p = providerById(cfg.provider);
  if (['openai', 'multi'].includes(p?.kind) && (has(p.id) || p.needsKey === false) && (!p.custom || cfg.baseURLs?.[p.id])) return 'provider';
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
  if (e.fromProvider) return transcribeViaProvider(cfg, audio, { gateway, signal, fetchImpl });
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

/** 要试的转写模型：服务商模型列表里真有的转写模型优先（名字各家不同，如 whisper-large-v3、SenseVoiceSmall），再试常见名字 */
export function sttCandidates(cfg) {
  const listed = [...new Set(Object.values(cfg.modelLists || {}).flatMap((l) => l.ids || []))]
    .filter((id) => /whisper|transcribe|sensevoice|paraformer|\basr\b|-asr|speech-to-text|stt/i.test(id) && !/tts|realtime/i.test(id));
  return [...new Set([...listed, ...PROVIDER_STT_MODELS])].slice(0, 5);
}

/** 用当前模型服务商的 /audio/transcriptions；依次试几个常见转写模型，记住能用的那个 */
async function transcribeViaProvider(cfg, audio, { gateway, signal, fetchImpl }) {
  const p = providerById(cfg.provider);
  if (!['openai', 'multi'].includes(p?.kind)) throw new Error('语音识别：当前服务商不支持语音转写，请在“模型 → 声音”里选择云端语音识别');
  const key = cfg.keys?.[p.id] || '';
  const viaGw = p.custom ? customViaGateway(gateway, cfg.baseURLs?.[p.id]) : Boolean(gateway && upstreamFor(p.id));
  const base = viaGw ? `${gateway.origin}/api/llm/${p.id}` : (p.custom ? cfg.baseURLs[p.id] : p.baseURL).replace(/\/$/, '');
  const headers = {};
  if (key || viaGw) headers.authorization = `Bearer ${key || 'use-gateway-key'}`;
  if (viaGw && p.custom) headers['x-jarvis-upstream'] = cfg.baseURLs[p.id].trim();
  const known = workingModel.get(base);
  const models = known ? [known] : sttCandidates(cfg);
  let last = '';
  for (const model of models) {
    const form = new FormData();
    form.append('file', audio, 'speech.wav');
    form.append('model', model);
    form.append('language', 'zh');
    const res = await fetchImpl(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form, signal });
    if (res.ok) {
      workingModel.set(base, model);
      const j = await res.json().catch(() => ({}));
      return cleanTranscript(j.text);
    }
    let msg = '';
    try { const j = await res.json(); msg = j.error?.message || j.message || ''; } catch { /* 非 JSON */ }
    last = `${res.status} ${msg}`.trim();
    if (res.status === 401 || res.status === 403) break; // 密钥问题：换模型也没用
  }
  throw new Error(`语音识别：你的模型服务商不支持语音转写（${last.slice(0, 80)}）。可在“模型 → 声音”填硅基流动的 Key 用 SenseVoice（中文准、注册送额度）`);
}
