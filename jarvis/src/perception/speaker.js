/**
 * 语音输出（需求 6.1）：句子凑齐就排进 speechSynthesis 队列，不等全文生成完。
 */
const synth = globalThis.speechSynthesis;
export const speechSynthesisSupported = Boolean(synth && globalThis.SpeechSynthesisUtterance);

export class Speaker {
  constructor({ lang = 'zh-CN', rate = 0.95, pitch = 1.0, onStart, onIdle } = {}) {
    Object.assign(this, { lang, rate, pitch, onStart, onIdle });
    this.enabled = true;
    this.pending = 0;
    this.voice = null;
    if (speechSynthesisSupported) {
      const pick = () => {
        const vs = synth.getVoices();
        this.voice = vs.find((v) => v.lang === 'zh-CN' && /Xiaoxiao|Yunxi|Google/.test(v.name))
          || vs.find((v) => v.lang?.replace('_', '-').startsWith('zh-CN'))
          || vs.find((v) => v.lang?.startsWith('zh'))
          || null;
      };
      pick();
      synth.addEventListener?.('voiceschanged', pick);
    }
  }

  get speaking() {
    return this.pending > 0;
  }

  speak(text) {
    if (!this.enabled || !speechSynthesisSupported || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.lang;
    u.rate = this.rate;
    u.pitch = this.pitch;
    if (this.voice) u.voice = this.voice;
    const done = () => {
      if (u._done) return;
      u._done = true;
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.onIdle?.();
    };
    u.onend = done;
    u.onerror = done;
    if (this.pending++ === 0) this.onStart?.();
    synth.speak(u);
  }

  cancel() {
    if (!speechSynthesisSupported) return;
    const had = this.pending > 0;
    this.pending = 0;
    synth.cancel();
    if (had) this.onIdle?.();
  }
}
