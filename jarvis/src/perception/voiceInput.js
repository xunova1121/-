/**
 * 直接对话的语音输入（需求 6.1、6.2）。
 *
 *   VAD（Silero，ONNX/WASM，浏览器本地） → VadGate 时序门控 → SpeechRecognition（zh-CN）
 *
 * 识别器在 VAD 一检测到声音（onset）时就打开，300ms 后确认为有效语句（confirm）；
 * 不到 300ms 就停了的视为误触发，abort 丢弃。这样“确认延迟”不会吃掉第一个音节。
 *
 * VAD 加载失败或超时 → 降级为“按下说话”（按住麦克风说、松开提交）。
 * 语音帧只在本机做 VAD 概率与音量包络计算，不录音、不上传；
 * 也不做任何语音情感分析 —— 音量包络只用来驱动粒子呼吸。
 */
import { VadGate } from '../core/vadGate.js';
import { VAD } from '../config.js';

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const speechRecognitionSupported = Boolean(SR);

export class VoiceInput {
  constructor({ onOnset, onConfirm, onCancel, onInterim, onFinal, onEnergy, onMode, onError } = {}) {
    Object.assign(this, { onOnset, onConfirm, onCancel, onInterim, onFinal, onEnergy, onMode, onError });
    this.mode = 'off'; // off | loading | vad | ptt
    this.vad = null;
    this.rec = null;
    this.finals = '';
    this.interim = '';
    this.wantRunning = false;
    this.committing = false;
    this.suppressed = false;
    this.energy = 0;
    this.gate = new VadGate({
      onOnset: () => this.#openRecognizer(),
      onConfirm: () => this.onConfirm?.(),
      onCancel: () => this.#abortRecognizer(),
      onCommit: () => this.#commit()
    });
  }

  async enable({ silenceMs = 800 } = {}) {
    if (!SR) throw new Error('当前浏览器不支持语音识别');
    this.gate.silenceMs = silenceMs;
    this.#setMode('loading');
    try {
      const { MicVAD } = await withTimeout(import('@ricky0123/vad-web'), VAD.loadTimeoutMs);
      this.vad = await withTimeout(MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD.baseAssetPath,
        onnxWASMBasePath: VAD.onnxWASMBasePath,
        startOnLoad: true,
        onFrameProcessed: (probs, frame) => this.#onFrame(probs.isSpeech, frame)
      }), VAD.loadTimeoutMs);
      if (this.mode !== 'loading') {
        // 加载期间用户又关掉了
        this.vad.destroy();
        this.vad = null;
        return this.mode;
      }
      this.#setMode('vad');
    } catch (err) {
      console.warn('[voice] VAD 不可用，降级为按下说话：', err);
      this.vad?.destroy?.();
      this.vad = null;
      if (this.mode === 'loading') this.#setMode('ptt');
    }
    return this.mode;
  }

  disable() {
    this.vad?.destroy?.();
    this.vad = null;
    this.#abortRecognizer();
    this.gate.reset();
    this.#setMode('off');
  }

  setSilenceMs(ms) {
    this.gate.silenceMs = ms;
  }

  /** 语音播报期间屏蔽 VAD，避免把扬声器里自己的声音当成用户说话 */
  setSuppressed(on) {
    this.suppressed = on;
    if (on && this.gate.phase !== 'idle') {
      this.gate.reset();
      this.#abortRecognizer();
    }
  }

  // —— 按下说话（降级模式）
  pttStart() {
    if (this.mode !== 'ptt') return;
    this.#openRecognizer();
    this.onConfirm?.();
  }

  pttEnd() {
    if (this.mode !== 'ptt') return;
    this.#commit();
  }

  #setMode(m) {
    this.mode = m;
    this.onMode?.(m);
  }

  #onFrame(prob, frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    // 包络：快起慢落
    this.energy = rms > this.energy ? rms * 0.6 + this.energy * 0.4 : this.energy * 0.85;
    this.onEnergy?.(this.gate.speaking && !this.suppressed ? Math.min(1, this.energy * 8) : 0);
    if (this.suppressed) return;
    this.gate.update(prob, performance.now());
  }

  #openRecognizer() {
    if (this.rec) return;
    this.finals = '';
    this.interim = '';
    this.committing = false;
    this.wantRunning = true;
    this.onOnset?.();
    this.#startRec();
  }

  #startRec() {
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finals += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.interim = interim;
      this.onInterim?.(this.finals + interim);
    };
    rec.onerror = (e) => {
      // no-speech / aborted 是识别噪声，静默处理，不触发“警觉”
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
        this.wantRunning = false;
        this.onError?.(e.error);
      }
    };
    rec.onend = () => {
      // continuous=false 时识别器会在短停顿后自行结束；用户仍在说话就接着开一段，文本累加
      if (this.rec !== rec) return;
      if (this.wantRunning && !this.committing) {
        this.finals += this.interim;
        this.interim = '';
        try { this.#startRec(); return; } catch { /* 落到下面按提交处理 */ }
      }
      this.rec = null;
      if (this.committing) {
        const text = (this.finals + this.interim).trim();
        this.finals = '';
        this.interim = '';
        if (text) this.onFinal?.(text);
        else this.onCancel?.();
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.onError?.(String(err?.message || err));
    }
  }

  #commit() {
    if (!this.rec) return;
    this.committing = true;
    this.wantRunning = false;
    this.rec.stop();
  }

  #abortRecognizer() {
    this.wantRunning = false;
    const rec = this.rec;
    this.rec = null;
    rec?.abort();
    if (rec) this.onCancel?.();
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms))]);
}
