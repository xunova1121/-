/**
 * 安卓 WebView 没有浏览器朗读（speechSynthesis）：用系统 TTS 插件补一个够用的版本，
 * 这样“浏览器自带声音”在手机上就是系统朗读引擎。
 */
export function installSpeechShim(tts, g = globalThis) {
  if (g.speechSynthesis && g.SpeechSynthesisUtterance) return false;
  class Utterance {
    constructor(text = '') { Object.assign(this, { text, lang: 'zh-CN', rate: 1, pitch: 1, volume: 1, voice: null, onstart: null, onend: null, onerror: null, onboundary: null }); }
  }
  let current = null;
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    speak(u) {
      const prev = current;
      current = u;
      synth.speaking = true;
      const run = async () => {
        if (prev) await prev.__done?.catch(() => {});
        if (current !== u) return u.onend?.({});
        u.onstart?.({});
        try {
          await tts.speak({ text: u.text, lang: u.lang || 'zh-CN', rate: u.rate ?? 1, pitch: u.pitch ?? 1, volume: u.volume ?? 1, category: 'playback' });
          u.onend?.({});
        } catch (e) {
          u.onerror?.({ error: String(e?.message || e) });
        } finally {
          if (current === u) { current = null; synth.speaking = false; }
        }
      };
      u.__done = run();
    },
    cancel() {
      const u = current;
      current = null;
      synth.speaking = false;
      tts.stop().catch(() => {});
      return u;
    },
    pause() {},
    resume() {}
  };
  g.SpeechSynthesisUtterance = Utterance;
  g.speechSynthesis = synth;
  return true;
}
