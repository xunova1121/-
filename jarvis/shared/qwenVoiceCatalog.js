import { QWEN_VOICE_SOURCE } from './qwenVoices.js';
export { QWEN_VOICE_SOURCE };
export const QWEN_VOICE_MODEL = 'qwen3-tts-flash-realtime';
const invalid = () => Object.assign(new Error('官方实时音色目录格式不正确，保留已有声音'), { code: 'QWEN_VOICE_CATALOG', kind: 'api' });

/** 最多200条、ID64字符、标签160字符；带空格的官方ID须原样保留。 */
export function normalizeQwenVoices(values) {
  if (!Array.isArray(values) || !values.length || values.length > 200) throw invalid();
  const voices = new Map();
  for (const item of values) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw invalid();
    const id = item[0].trim();
    if (id.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z][A-Za-z0-9_-]*){0,3}$/.test(id)) throw invalid();
    voices.set(id, [id, item[1].replace(/[\r\n<>]/g, ' ').trim().slice(0, 160)]);
  }
  return [...voices.values()];
}

/** 只解析官方明确标记的实时模型章节；不执行网页脚本，缺标记就失败。 */
export function parseQwenVoiceCatalog(html) {
  if (typeof html !== 'string' || html.length > 2000000) throw invalid();
  let content = html;
  const encoded = html.match(/"content"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (encoded) {
    try { content = JSON.parse(encoded[1]); } catch { throw invalid(); }
  }
  const start = content.indexOf('以下音色支持');
  if (start < 0 || !content.slice(start, start + 500).includes(QWEN_VOICE_MODEL)) throw invalid();
  const end = content.indexOf('非实时语音合成', start);
  if (end < 0) throw invalid();
  const section = content.slice(start, end);
  const voices = [];
  for (const match of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const voice = text.match(/名称\s*[：:]\s*(.*?)\s+voice\s*参数\s*[：:]\s*([A-Za-z][A-Za-z0-9_ -]+?)\s+描述\s*[：:]\s*(.*)/);
    if (!voice) continue;
    const gender = voice[3].includes('女性') ? '女声' : voice[3].includes('男性') ? '男声' : '声音';
    voices.push([voice[2], voice[1] + ' · ' + gender]);
    if (voices.length > 200) throw invalid();
  }
  const result = normalizeQwenVoices(voices);
  if (result.length < 20 || !['Cherry', 'Bella', 'Mia'].every(id => result.some(voice => voice[0] === id))) throw invalid();
  return { model: QWEN_VOICE_MODEL, source: QWEN_VOICE_SOURCE, voices: result };
}
