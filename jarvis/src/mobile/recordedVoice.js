import { encodeWav } from '../perception/stt.js';

/** 安卓没有系统识别服务时，用轻量音量门控录一句；不加载 ONNX/WASM，避免占用几百 MB。 */
export class RecordedVoice {
  constructor({ getTranscriber, ...handlers }) { Object.assign(this, handlers); this.getTranscriber = getTranscriber; this.mode = 'off'; this.gen = 0; this.suppressed = false; this.frames = []; }
  async enable({ silenceMs = 900 } = {}) {
    this.disable();
    const gen = ++this.gen;
    if (!this.getTranscriber()) throw new Error('当前服务商没有语音转写，请在“模型 → 声音”配置语音识别');
    this.mode = 'loading'; this.onMode?.(this.mode);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (gen !== this.gen) { stream.getTracks().forEach(t => t.stop()); return 'off'; }
      this.stream = stream;
      this.context = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      await this.context.resume();
      if (gen !== this.gen) return 'off';
      this.silenceMs = silenceMs;
      this.source = this.context.createMediaStreamSource(stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.source.connect(this.processor);
      this.processor.connect(this.context.destination); // 输出缓冲默认静音，不播放麦克风
      this.processor.onaudioprocess = e => this.process(e.inputBuffer.getChannelData(0));
      this.mode = 'vad'; this.onMode?.(this.mode);
      return this.mode;
    } catch (e) { if (gen === this.gen) this.disable(); throw e; }
  }
  process(samples) {
    if (this.mode !== 'vad' || this.suppressed || this.busy) return;
    const now = performance.now();
    const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    this.onEnergy?.(Math.min(1, rms * 8));
    if (rms > .015) {
      if (!this.started) { this.started = now || 1; this.onConfirm?.(); }
      this.lastSound = now;
    }
    if (!this.started) return;
    this.frames.push(samples.slice());
    if (now - this.lastSound > this.silenceMs || now - this.started > 20000) this.commit();
  }
  async commit() {
    if (!this.frames.length || this.busy) return;
    const gen = this.gen, frames = this.frames;
    const rate = this.context.sampleRate;
    this.reset(); this.busy = true;
    this.ctrl = new AbortController();
    try {
      const samples = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
      let off = 0; for (const f of frames) { samples.set(f, off); off += f.length; }
      const text = await this.getTranscriber()(encodeWav(samples, rate), this.ctrl.signal);
      if (gen === this.gen && text) this.onFinal?.(text);
    } catch (e) { if (gen === this.gen && e.name !== 'AbortError') this.onError?.(e.message); }
    finally { if (gen === this.gen) { this.busy = false; this.ctrl = null; this.onCancel?.(); } }
  }
  reset() { this.frames = []; this.started = 0; this.lastSound = 0; this.onEnergy?.(0); }
  disable() {
    this.gen++; this.ctrl?.abort(); this.ctrl = null; this.busy = false;
    if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }
    this.source?.disconnect(); this.stream?.getTracks().forEach(t => t.stop());
    this.context?.close().catch(() => {}); this.context = this.stream = this.source = this.processor = null;
    this.reset(); this.mode = 'off'; this.onMode?.(this.mode);
  }
  setSuppressed(on) { this.suppressed = on; if (on) this.reset(); }
  setSilenceMs(ms) { this.silenceMs = ms; }
  pttStart() {} pttEnd() {}
}
