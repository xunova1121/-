/**
 * 语音合成引擎目录与请求。
 *   browser      浏览器自带（免费；音色取决于系统，无法加声线效果）
 *   openai       OpenAI gpt-4o-mini-tts：可以用文字“导演”语气，避免播报腔
 *   elevenlabs   ElevenLabs：目前最接近真人的配音
 *   siliconflow  硅基流动 CosyVoice2：中文自然度高
 *   edge         Edge 在线朗读：免费、免密钥，和 Edge 浏览器“大声朗读”同一套神经网络声音（经本机网关，桌面版 / 完整版）
 *   custom       任意 OpenAI 兼容的 /audio/speech 接口（如自建 CosyVoice / GPT-SoVITS 服务）
 * 云端引擎返回音频，经 voiceFx 效果链后播放。
 */

import { customViaGateway } from '../../shared/providers.js';
import { EDGE_VOICES } from '../../shared/edgeVoices.js';

/** 给 gpt-4o-mini-tts 的“表演指导”：要像电影里的 AI 管家，而不是导航播报 */
export const DIRECTION = [
  'Voice: a gentle young girl AI companion with a feminine, youthful, childlike voice with a soft, bright and comforting tone.',
  'Delivery: natural and human, kind and patient; never robotic, never shrill, never sing-song, no announcer tone. Do not imitate any real person.',
  'Pacing: unhurried, with natural pauses between clauses. Speak Chinese with standard Mandarin pronunciation.'
].join(' ');

export const TTS_ENGINES = [
  { id: 'browser', name: '浏览器自带（免费）', fx: false },
  {
    id: 'edge', name: 'Edge 朗读（免费 · 免密钥）', free: true, browser: false, voices: EDGE_VOICES,
    note: '和 Edge 浏览器“大声朗读”同一套声音，不用注册。这不是微软正式开放的接口，万一失效会自动改用系统声音'
  },
  {
    id: 'openai', name: 'OpenAI 语音（可导演语气）', keyFrom: 'openai', model: 'gpt-4o-mini-tts', browser: true, keyUrl: 'https://platform.openai.com/api-keys',
    voices: [['nova', 'Nova · 温柔明亮（默认）'], ['onyx', 'Onyx · 低沉男声'], ['ash', 'Ash · 沉稳男声'], ['echo', 'Echo · 清朗男声'], ['fable', 'Fable · 英式男声'], ['verse', 'Verse · 磁性男声'], ['sage', 'Sage · 知性女声']]
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs（最接近真人）', keyFrom: 'elevenlabs', model: 'eleven_multilingual_v2', browser: true, keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    voices: [['onwK4e9ZLuTAKqWW03F9', 'Daniel · 英式播音男声'], ['JBFqnCBsd6RMkjVDRZzb', 'George · 温暖英式男声'], ['pNInz6obpgDQGcFmaJgB', 'Adam · 低沉男声'], ['N2lVS1w4EtoT3dr4eOWO', 'Callum · 沙哑男声'], ['EXAVITQu4vr4xnSDxMaL', 'Sarah · 柔和女声']],
    note: '也可以填你在 ElevenLabs 里克隆或收藏的任意声音 ID'
  },
  {
    id: 'siliconflow', name: '硅基流动 CosyVoice2（中文自然）', keyFrom: 'siliconflow', model: 'FunAudioLLM/CosyVoice2-0.5B', browser: false, keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    voices: [['alex', 'Alex · 沉稳男声'], ['benjamin', 'Benjamin · 低沉男声'], ['charles', 'Charles · 磁性男声'], ['david', 'David · 欢快男声'], ['anna', 'Anna · 沉稳女声'], ['bella', 'Bella · 激情女声'], ['claire', 'Claire · 温柔女声'], ['diana', 'Diana · 欢快女声']]
  },
  { id: 'custom', name: '自定义（OpenAI 兼容）', keyFrom: 'tts-custom', custom: true, browser: true, voices: [] }
];

export const ttsEngineById = (id) => TTS_ENGINES.find((e) => e.id === id);

/**
 * 浏览器自带声音排序：中文童声 > 自然的温柔中文声音 > 其他中文声音。
 */
export function rankBrowserVoices(voices) {
  const score = (v) => {
    const n = v.name;
    const lang = (v.lang || '').replace('_', '-');
    let s = 0;
    if (/^zh-CN/i.test(lang)) s += 100; else if (/^zh/i.test(lang)) s += 80; else if (/^en/i.test(lang)) s += 5; else s -= 100;
    if (/Natural|Neural|Online/i.test(n)) s += 30;
    if (/Xiaoshuang|Xiaoyou|女童|女孩童声|child|kid/i.test(n)) s += 60;
    else if (/Xiaoxiao|Xiaoyi|Xiaomeng|Xiaohan|温柔|女声|female/i.test(n)) s += 40;
    if (/Google/i.test(n)) s += 6;
    if (/Huihui|compact|eSpeak/i.test(n)) s -= 8;
    return s;
  };
  return voices.filter((v) => score(v) > -50).sort((a, b) => score(b) - score(a));
}

/**
 * 请求一句话的音频（ArrayBuffer，mp3）。
 * @param {object} vc 语音配置 { engine, voices, customURL, customModel }
 * @param {object} keys 密钥表（与模型配置共用）
 * @param {string} text
 * @param {{ gateway?: {origin:string, keys:string[]}|null, signal?: AbortSignal, fetchImpl?: typeof fetch }} opts
 */
export async function synthesize(vc, keys, text, { gateway = null, signal, fetchImpl = globalThis.fetch } = {}) {
  const e = ttsEngineById(vc.engine);
  if (!e || e.id === 'browser') throw new Error('不是云端语音引擎');
  const voice = vc.voices?.[e.id] || e.voices[0]?.[0] || '';
  if (e.id === 'edge') {
    if (!gateway && globalThis.__jarvisEdgeSpeech) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const id = crypto.randomUUID();
      const plugin = globalThis.__jarvisEdgeSpeech;
      const abort = () => { plugin.cancel({ id }).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const { audio } = await plugin.synthesize({ id, text, voice, pitch: vc.edgePitch ?? 8 });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return Uint8Array.from(atob(audio), c => c.charCodeAt(0)).buffer;
      } finally { signal?.removeEventListener('abort', abort); }
    }
    if (!gateway) throw new Error('Edge 朗读需要安卓 App 或电脑本机网关');
    const res = await fetchImpl(`${gateway.origin}/api/tts/edge`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-jarvis-client': '1' },
      body: JSON.stringify({ text, voice, rate: vc.edgeRate ?? -4, pitch: vc.edgePitch ?? 0 })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`语音合成失败：${j.error || res.status}`);
    }
    return res.arrayBuffer();
  }
  const key = keys?.[e.keyFrom] || '';
  const viaGateway = e.custom ? customViaGateway(gateway, vc.customURL) : Boolean(gateway);
  if (!key && !e.custom && !(viaGateway && gateway.keys?.includes(e.keyFrom))) throw new Error(`请先填写 ${e.name} 的 API Key`);

  let url;
  let init;
  if (e.id === 'elevenlabs') {
    const base = viaGateway ? `${gateway.origin}/api/llm/elevenlabs` : 'https://api.elevenlabs.io';
    url = `${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
    init = {
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': key || 'use-gateway-key' },
      body: JSON.stringify({ text, model_id: e.model, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } })
    };
  } else {
    if (e.custom && !vc.customURL) throw new Error('请填写自定义语音接口地址');
    const base = viaGateway ? `${gateway.origin}/api/llm/${e.id}` : e.custom ? vc.customURL.replace(/\/$/, '') : (e.id === 'openai' ? 'https://api.openai.com/v1' : 'https://api.siliconflow.cn/v1');
    url = `${base}/audio/speech`;
    const body = { model: e.custom ? (vc.customModel || 'tts-1') : e.model, input: text, voice: e.id === 'siliconflow' ? `${e.model}:${voice}` : voice, response_format: 'mp3' };
    if (e.id === 'openai') body.instructions = DIRECTION;
    if (e.custom && vc.customVoice) body.voice = vc.customVoice;
    const headers = { 'content-type': 'application/json' };
    if (e.custom && viaGateway) headers['x-jarvis-upstream'] = vc.customURL.trim();
    if (key || viaGateway) headers.authorization = `Bearer ${key || 'use-gateway-key'}`;
    init = { headers, body: JSON.stringify(body) };
  }
  const res = await fetchImpl(url, { method: 'POST', ...init, signal });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg += ` ${j.error?.message || j.detail?.message || j.message || JSON.stringify(j).slice(0, 120)}`; } catch { /* 非 JSON */ }
    throw new Error(`语音合成失败：${msg}`);
  }
  return res.arrayBuffer();
}
