/**
 * 语音输出（需求 6.1）：句子凑齐就排队朗读，不等全文生成完。
 *
 * 两条路径：
 *   - 云端语音（OpenAI / ElevenLabs / CosyVoice …）：预取后面几句的音频，按顺序经“科幻声线”效果链播放，
 *     光核的说话动画由真实音量驱动；某句合成失败时这一句退回浏览器自带声音，不中断。
 *   - 浏览器自带 speechSynthesis：免费、离线，但拿不到音频流，无法加效果，用词边界事件近似说话包络。
 */
import { buildFx, levelOf, playCue } from './voiceFx.js';
import { synthesize, ttsEngineById, rankBrowserVoices } from './tts.js';

// 用时再取：安卓 App 启动时才补上 speechSynthesis（见 src/mobile/speechShim.js）
const synth = { get getVoices() { return globalThis.speechSynthesis.getVoices.bind(globalThis.speechSynthesis); }, get addEventListener() { return globalThis.speechSynthesis.addEventListener?.bind(globalThis.speechSynthesis); }, cancel: () => globalThis.speechSynthesis.cancel(), speak: (u) => globalThis.speechSynthesis.speak(u) };
export const speechSynthesisSupported = () => Boolean(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance);
const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
const PREFETCH = 3;

export class Speaker {
  /**
   * @param {object} o
   * @param {() => object} [o.getVoiceConfig] 当前语音配置 { engine, voices, fx, cues, browserVoice, … }
   * @param {() => object} [o.getKeys] 密钥表
   * @param {() => object|null} [o.getGateway]
   */
  constructor({ lang = 'zh-CN', rate = 0.95, pitch = 1.0, onStart, onIdle, onBoundary, onError, getVoiceConfig, getKeys, getGateway } = {}) {
    Object.assign(this, { lang, rate, pitch, onStart, onIdle, onBoundary, onError });
    this.getVoiceConfig = getVoiceConfig ?? (() => ({ engine: 'browser' }));
    this.getKeys = getKeys ?? (() => ({}));
    this.getGateway = getGateway ?? (() => null);
    this.enabled = true;
    this.pending = 0;
    this.voice = null;
    this.voices = [];
    this.queue = [];
    this.gen = 0;
    this.ctrl = null;
    this.ctx = null;
    this.fx = null;
    this.fxId = '';
    this.source = null;
    this.playing = false;
    this.lastError = '';
    if (speechSynthesisSupported()) {
      const pick = () => {
        this.voices = rankBrowserVoices(synth.getVoices());
        this.voice = this.voices[0] ?? null;
      };
      pick();
      synth.addEventListener?.('voiceschanged', () => { pick(); this.onVoicesChanged?.(this.voices); });
    }
  }

  get speaking() {
    return this.pending > 0;
  }

  /** 当前是否走云端音频 + 效果链 */
  get usesAudio() {
    const e = ttsEngineById(this.getVoiceConfig().engine);
    return Boolean(AudioCtx && e && e.id !== 'browser');
  }

  /** 在用户手势里调用：浏览器要求音频上下文由点击 / 按键启动 */
  unlock() {
    if (!AudioCtx) return null;
    try {
      this.ctx ??= new AudioCtx({ latencyHint: 'playback' });
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch { this.ctx = null; }
    return this.ctx;
  }

  /** 正在播放的真实音量（0..1）；浏览器自带声音时返回 null */
  level() {
    if (!this.source || !this.fx) return null;
    this.levelBuf ??= new Float32Array(this.fx.analyser.fftSize);
    return levelOf(this.fx.analyser, this.levelBuf);
  }

  speak(text) {
    if (!this.enabled || !text) return;
    if (!this.usesAudio) {
      if (!speechSynthesisSupported()) return;
      this.#begin();
      const gen = this.gen;
      this.#browserSay(text).then(() => { if (gen === this.gen) this.#finish(); });
      return;
    }
    this.#begin();
    this.queue.push({ text, gen: this.gen, p: null });
    this.#prefetch();
    this.#play();
  }

  /** 试听：用当前配置读一句 */
  preview(text = '您好，我是未央。所有系统运行正常，随时为您效劳。') {
    this.cancel();
    this.unlock();
    const was = this.enabled;
    this.enabled = true;
    this.speak(text);
    this.enabled = was;
  }

  cancel() {
    const had = this.pending > 0;
    this.gen++;
    this.ctrl?.abort();
    this.ctrl = null;
    this.queue = [];
    if (this.source) { try { this.source.onended = null; this.source.stop(); } catch { /* 已停止 */ } }
    this.source = null;
    this.playing = false;
    if (speechSynthesisSupported()) synth.cancel();
    this.pending = 0;
    if (had) this.onIdle?.();
  }

  // ------------------------------------------------------------ 内部
  #begin() {
    if (this.pending++ === 0) {
      const vc = this.getVoiceConfig();
      if (vc.cues !== false) {
        const ctx = this.unlock();
        if (ctx?.state === 'running') playCue(ctx, 'start');
      }
      this.onStart?.();
    }
  }

  #finish() {
    if (this.pending === 0) return;
    this.pending--;
    if (this.pending === 0) {
      if (this.getVoiceConfig().cues !== false && this.ctx?.state === 'running') playCue(this.ctx, 'end', 0.04);
      this.onIdle?.();
    }
  }

  #browserSay(text) {
    return new Promise((resolve) => {
      if (!speechSynthesisSupported()) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const vc = this.getVoiceConfig();
      const chosen = vc.browserVoice && this.voices.find((v) => v.name === vc.browserVoice);
      const voice = chosen || this.voice;
      u.lang = voice?.lang || this.lang;
      // 默认声音略压低、放慢一点，减少“播报腔”
      u.rate = this.rate;
      u.pitch = this.pitch * 0.92;
      if (voice) u.voice = voice;
      let done = false;
      const end = () => { if (!done) { done = true; resolve(); } };
      u.onboundary = () => this.onBoundary?.();
      u.onend = end;
      u.onerror = end;
      synth.speak(u);
    });
  }

  #prefetch() {
    this.ctrl ??= new AbortController();
    const vc = this.getVoiceConfig();
    for (const item of this.queue.slice(0, PREFETCH)) {
      if (item.p) continue;
      const ctx = this.unlock();
      // 这个引擎刚失败过：5 分钟内直接用浏览器声音，不再每句都先等它失败
      if ((this.down?.[vc.engine] ?? 0) > Date.now()) { item.p = Promise.reject(Object.assign(new Error('skip'), { name: 'SkipError' })); item.p.catch(() => {}); continue; }
      item.p = synthesize(vc, this.getKeys(), item.text, { gateway: this.getGateway(), signal: this.ctrl.signal })
        .then((ab) => ctx.decodeAudioData(ab))
        .catch((e) => {
          if (e?.name !== 'AbortError') (this.down ??= {})[vc.engine] = Date.now() + 5 * 60_000;
          throw e;
        });
      item.p.catch(() => {}); // 错误在播放时处理
    }
  }

  async #play() {
    if (this.playing) return;
    this.playing = true;
    while (this.queue.length) {
      const item = this.queue[0];
      const gen = item.gen;
      let buffer = null;
      try {
        buffer = await item.p;
      } catch (e) {
        if (gen !== this.gen) return;
        if (e?.name !== 'AbortError' && e?.name !== 'SkipError' && e.message !== this.lastError) {
          this.lastError = e.message;
          this.onError?.(e);
        }
      }
      if (gen !== this.gen) return;
      if (buffer) await this.#playBuffer(buffer, gen);
      else await this.#browserSay(item.text); // 这一句合成失败：用浏览器声音补上
      if (gen !== this.gen) return;
      this.queue.shift();
      this.#prefetch();
      this.#finish();
    }
    this.playing = false;
  }

  #playBuffer(buffer, gen) {
    const ctx = this.unlock();
    const fxId = this.getVoiceConfig().fx || 'jarvis';
    if (!this.fx || this.fxId !== fxId) {
      this.fx?.dispose();
      this.fx = buildFx(ctx, fxId);
      this.fxId = fxId;
    }
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.detune.value = this.fx.detune;
      src.connect(this.fx.input);
      src.onended = () => {
        if (this.source === src) this.source = null;
        try { src.disconnect(); } catch { /* ignore */ }
        resolve();
      };
      if (gen !== this.gen) return resolve();
      this.source = src;
      src.start();
    });
  }
}
