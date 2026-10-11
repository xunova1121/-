/**
 * 语音合成引擎目录与请求。
 *   browser      浏览器自带（免费；音色取决于系统，无法加声线效果）
 *   openai       OpenAI gpt-4o-mini-tts：可以用文字“导演”语气，避免播报腔
 *   elevenlabs   ElevenLabs：目前最接近真人的配音
 *   siliconflow  硅基流动 CosyVoice2：中文自然度高
 *   custom       任意 OpenAI 兼容的 /audio/speech 接口（如自建 CosyVoice / GPT-SoVITS 服务）
 * 云端引擎返回音频，经 voiceFx 效果链后播放。
 */

/** 给 gpt-4o-mini-tts 的“表演指导”：要像电影里的 AI 管家，而不是导航播报 */
export const DIRECTION = [
  'Voice: a calm, precise, quietly confident AI butler from a science-fiction film.',
  'Delivery: natural and human, warm but composed; subtle dry wit; never robotic, never sing-song, no announcer tone.',
  'Pacing: unhurried, with natural pauses between clauses. Speak Chinese with standard Mandarin pronunciation.'
].join(' ');

export const TTS_ENGINES = [
  { id: 'browser', name: '浏览器自带（免费）', fx: false },
  {
    id: 'openai', name: 'OpenAI 语音（可导演语气）', keyFrom: 'openai', model: 'gpt-4o-mini-tts', browser: true, keyUrl: 'https://platform.openai.com/api-keys',
    voices: [['onyx', 'Onyx · 低沉男声'], ['ash', 'Ash · 沉稳男声'], ['echo', 'Echo · 清朗男声'], ['fable', 'Fable · 英式男声'], ['verse', 'Verse · 磁性男声'], ['sage', 'Sage · 知性女声'], ['nova', 'Nova · 明亮女声']]
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
 * 浏览器自带声音排序：神经网络（Natural / Neural / Online）> 男声（更像贾维斯）> 中文 > 其他。
 * Edge 浏览器的“Yunjian / Yunxi (Natural)”是免费声音里最自然的。
 */
export function rankBrowserVoices(voices) {
  const score = (v) => {
    const n = v.name;
    const lang = (v.lang || '').replace('_', '-');
    let s = 0;
    if (/^zh-CN/i.test(lang)) s += 40; else if (/^zh/i.test(lang)) s += 25; else if (/^en/i.test(lang)) s += 5; else s -= 100;
    if (/Natural|Neural|Online/i.test(n)) s += 30;
    if (/Yunjian|Yunxi|Yunyang|Yunze|Yunfeng|Yunhao|Kangkang|Daniel|Guy|Ryan|Christopher/i.test(n)) s += 12;
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
  const key = keys?.[e.keyFrom] || '';
  const viaGateway = Boolean(gateway) && !e.custom;
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
    const base = e.custom ? (vc.customURL || '').replace(/\/$/, '') : viaGateway ? `${gateway.origin}/api/llm/${e.id}` : (e.id === 'openai' ? 'https://api.openai.com/v1' : 'https://api.siliconflow.cn/v1');
    if (!base) throw new Error('请填写自定义语音接口地址');
    url = `${base}/audio/speech`;
    const body = { model: e.custom ? (vc.customModel || 'tts-1') : e.model, input: text, voice: e.id === 'siliconflow' ? `${e.model}:${voice}` : voice, response_format: 'mp3' };
    if (e.id === 'openai') body.instructions = DIRECTION;
    if (e.custom && vc.customVoice) body.voice = vc.customVoice;
    const headers = { 'content-type': 'application/json' };
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
