import { secMsGec } from '../../shared/edgeGec.js';
/**
 * 语音合成引擎目录与请求（只留三种，其余 2026-10 按用户要求去掉）：
 *   qwen-realtime  百炼实时语音：流式合成边收边播（推荐，见 qwenRealtime）
 *   edge           Edge 在线朗读：免费、免密钥（安卓原生插件 / 电脑本机网关）
 *   browser        手机 / 浏览器自带（免费；音色取决于系统，无法加声线效果）
 * 云端引擎返回音频，经 voiceFx 效果链后播放。
 */

import { QWEN_VOICES } from '../../shared/qwenRealtime.js';
import { EDGE_VOICES } from '../../shared/edgeVoices.js';

export const TTS_ENGINES = [
  { id:'qwen-realtime',name:'百炼 Qwen3 实时语音（推荐）',keyFrom:'qwen',model:'qwen3-tts-flash-realtime',browser:true,voices:QWEN_VOICES,note:'实时合成并播放，支持完整官方实时音色目录；选择声音后可试听。与百炼识别共用对应地域的密钥。' },
  {
    id: 'edge', name: '免费在线声音（Edge 朗读，免密钥）', free: true, browser: false, voices: EDGE_VOICES,
    note: '和 Edge 浏览器“大声朗读”同一套声音，不用注册。这不是微软正式开放的接口，万一失效会自动改用手机自带的声音'
  },
  { id: 'browser', name: '手机 / 系统自带（免费）', fx: false }
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
  if (e.id === 'qwen-realtime') throw new Error('百炼实时语音使用流式播放，请使用新版播放器');
  const voice = vc.voices?.[e.id] || e.voices[0]?.[0] || '';
  if (e.id === 'edge') {
    if (!gateway && globalThis.__jarvisEdgeSpeech) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const id = crypto.randomUUID();
      const plugin = globalThis.__jarvisEdgeSpeech;
      const abort = () => { plugin.cancel({ id }).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const { audio } = await plugin.synthesize({ id, text, voice, pitch: vc.edgePitch ?? 8, gec:secMsGec() });
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return Uint8Array.from(atob(audio), c => c.charCodeAt(0)).buffer;
      } finally { signal?.removeEventListener('abort', abort); }
    }
    if (!gateway) throw new Error('Edge 朗读需要安卓 App 或电脑本机网关');
    const res = await fetchImpl(`${gateway.origin}/api/tts/edge`, {
      method: 'POST', binary:true, signal,
      headers: { 'content-type': 'application/json', 'x-jarvis-client': '1' },
      body: JSON.stringify({ text, voice, rate: vc.edgeRate ?? -4, pitch: vc.edgePitch ?? 0 })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`语音合成失败：${j.error || res.status}`);
    }
    return res.arrayBuffer();
  }
  throw new Error('不支持的语音引擎');
}
