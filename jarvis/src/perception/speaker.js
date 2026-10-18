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
import { streamQwenSpeech } from './qwenRealtime.js';
import { browserDelivery } from './voiceProfile.js';

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
  constructor({ lang = 'zh-CN', rate = 0.95, pitch = 1.0, onStart, onIdle, onBoundary, onError, onEngine, getVoiceConfig, getKeys, getGateway, getConfig } = {}) {
    Object.assign(this, { lang, rate, pitch, onStart, onIdle, onBoundary, onError });
    this.getVoiceConfig = getVoiceConfig ?? (() => ({ engine: 'browser' }));
    this.getConfig = getConfig || (() => ({}));
    this.onEngine = onEngine;
    this.getKeys = getKeys ?? (() => ({}));
    this.getGateway = getGateway ?? (() => null);
    this.enabled = true;
    this.foreground = true;
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

  setForeground(active) { this.foreground = active; if (!active) this.cancel(); }

  speak(text) {
    if (!this.foreground || !this.enabled || !text) return;
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
  preview(text = '你好呀，我是未央。慢慢说，我在听呢。') {
    this.cancel();
    this.unlock();
    const was = this.enabled;
    this.enabled = true;
    this.speak(text);
    this.enabled = was;
  }

  /** 检测实际选中的声音服务，失败就报告，不把系统回退当成目标音色成功。 */
  async test(text = '你好呀，我是未央。很高兴陪着你。') {
    if (!this.foreground) throw new Error('请回到未央界面后试听');
    this.cancel(); const gen = this.gen, vc = this.getVoiceConfig(); this.#begin();
    try {
      if (vc.engine === 'browser') { await this.#browserSay(text); return { engine:'browser', voice:this.voice?.name || '系统默认' }; }
      const ctx = this.unlock(); if (!ctx) throw new Error('当前 WebView 没有可用的音频播放环境');
      this.ctrl = new AbortController();
      if (vc.engine === 'qwen-realtime') {
        await this.#playRealtime(text,gen);
        return { engine:vc.engine, voice:vc.voices?.[vc.engine] || 'Bella' };
      }
      const ab = await synthesize(vc,this.getKeys(),text,{gateway:this.getGateway(),config:this.getConfig(),signal:this.ctrl.signal});
      if (gen !== this.gen || !this.foreground) throw new DOMException('Aborted','AbortError');
      const buffer = await ctx.decodeAudioData(ab);
      if (gen !== this.gen || !this.foreground) throw new DOMException('Aborted','AbortError');
      this.onEngine?.(vc.engine,false); await this.#playBuffer(buffer,gen);
      return { engine:vc.engine, voice:vc.voices?.[vc.engine] || '', duration:buffer.duration };
    } finally { if (gen === this.gen) this.#finish(); }
  }

  cancel() {
    const had = this.pending > 0;
    this.gen++;
    this.ctrl?.abort();
    this.ctrl = null;
    this.queue = [];
    for (const src of this.realtimeSources || []) { try { src.onended = null; src.stop(); src.disconnect(); } catch {} }
    this.realtimeSources?.clear();this.realtimeDone?.();this.realtimeDone=null;
    if (this.source) { try { this.source.onended = null; this.source.stop(); } catch { /* 已停止 */ } }
    this.source = null;
    this.playbackDone?.(); this.playbackDone = null;
    this.browserDone?.(); this.browserDone = null;
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
      const delivery = browserDelivery(voice, { rate: this.rate, pitch: this.pitch, profile: vc.profile });
      u.rate = delivery.rate;
      u.pitch = delivery.pitch;
      if (voice) u.voice = voice;
      let done = false;
      const end = () => { if (!done) { done = true; if (this.browserDone === end) this.browserDone = null; resolve(); } };
      this.browserDone = end;
      u.onboundary = () => this.onBoundary?.();
      u.onend = end;
      u.onerror = end;
      synth.speak(u);
    });
  }

  #prefetch() {
    if (this.getVoiceConfig().engine === 'qwen-realtime') return;
    this.ctrl ??= new AbortController();
    const vc = this.getVoiceConfig();
    for (const item of this.queue.slice(0, PREFETCH)) {
      if (item.p) continue;
      const ctx = this.unlock();
      // 这个引擎刚失败过：5 分钟内直接用浏览器声音，不再每句都先等它失败
      if ((this.down?.[vc.engine] ?? 0) > Date.now()) { item.p = Promise.reject(Object.assign(new Error('skip'), { name: 'SkipError' })); item.p.catch(() => {}); continue; }
      item.p = synthesize(vc, this.getKeys(), item.text, { gateway: this.getGateway(), signal: this.ctrl.signal, config:this.getConfig() })
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
      if (this.getVoiceConfig().engine === 'qwen-realtime') {
        try { await this.#playRealtime(item.text, gen); }
        catch (e) { if (gen === this.gen && e.name !== 'AbortError') this.onError?.(e); }
        if (gen !== this.gen) return;
        this.queue.shift();this.#finish();continue;
      }
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
      if (buffer) { this.onEngine?.(this.getVoiceConfig().engine,false); await this.#playBuffer(buffer, gen); }
      else { this.onEngine?.('browser',true); await this.#browserSay(item.text); } // 这一句合成失败：用浏览器声音补上
      if (gen !== this.gen) return;
      this.queue.shift();
      this.#prefetch();
      this.#finish();
    }
    this.playing = false;
  }


  /** PCM分片按时间轴连续排队，取消时同时停止已排队的全部音源。 */
  async #playRealtime(text,gen) {
    const ctx=this.unlock();if(!ctx)throw new Error('当前系统没有音频播放能力');
    const vc=this.getVoiceConfig(),fxId=vc.fx||'gentle';
    if(!this.fx||this.fxId!==fxId){this.fx?.dispose();this.fx=buildFx(ctx,fxId);this.fxId=fxId;}
    this.ctrl??=new AbortController();
    const sources=new Set();this.realtimeSources=sources;
    let next=ctx.currentTime,ended=false;
    let resolvePlayback;const playback=new Promise(r=>{resolvePlayback=r;});
    this.realtimeDone=resolvePlayback;
    const check=()=>{if(ended&&!sources.size)resolvePlayback();};
    try{
      await streamQwenSpeech(text,{
        key:this.getKeys().qwen||'',region:vc.qwenRegion||'beijing',voice:vc.voices?.['qwen-realtime']||'Bella',gateway:this.getGateway(),signal:this.ctrl.signal,
        onAudio:(samples,rate)=>{
          if(gen!==this.gen||!this.foreground)throw new DOMException('Aborted','AbortError');
          if(next-ctx.currentTime>60)throw new Error('音频排队过长，请缩短单句朗读');
          const buffer=ctx.createBuffer(1,samples.length,rate);buffer.getChannelData(0).set(samples);
          const src=ctx.createBufferSource();src.buffer=buffer;src.detune.value=this.fx.detune;src.connect(this.fx.input);
          src.onended=()=>{sources.delete(src);src.disconnect();if(this.source===src)this.source=null;check();};
          sources.add(src);this.source=src;this.onEngine?.('qwen-realtime',false);
          const at=Math.max(ctx.currentTime+0.02,next);next=at+buffer.duration;src.start(at);
        }
      });
      ended=true;check();await playback;
    }finally{
      for(const src of sources){try{src.onended=null;src.stop();src.disconnect();}catch{}if(this.source===src)this.source=null;}
      sources.clear();if(this.realtimeSources===sources)this.realtimeSources=null;
      if(this.realtimeDone===resolvePlayback)this.realtimeDone=null;
    }
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
      const finish = () => {
        if (this.source === src) this.source = null;
        try { src.disconnect(); } catch { /* ignore */ }
        if (this.playbackDone === finish) this.playbackDone = null;
        resolve();
      };
      src.onended = finish; this.playbackDone = finish;
      if (gen !== this.gen) return resolve();
      this.source = src;
      src.start();
    });
  }
}
