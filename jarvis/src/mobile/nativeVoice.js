/**
 * 安卓 App 的“直接对话”：用手机系统自带的语音识别（免费、不需要密钥，中文由手机厂商的识别服务提供）。
 * 系统识别器自己判断一句话什么时候说完，所以不需要网页里的语音活动检测模型。
 * 循环：开始听 → 说完拿到文字 → 交给对话 → 未央朗读期间暂停（免得听到自己）→ 接着听。
 * 和 VoiceInput 的接口一致，main.js 不用区分。
 */
import { nativeSpeechAttempt } from './nativeSpeechAttempt.js';
const RESTART_MS = 350;
const capabilities = new WeakMap();
// 没听到 / 没听清：安静地接着听；网络、权限等问题才提示
const QUIET_ERRORS = /no match|didn't understand|no speech|busy|client side/i;

export class NativeVoice {
  /** @param {{ plugin: object, onConfirm?, onCancel?, onInterim?, onFinal?, onMode?, onError?, onEnergy? }} o */
  constructor({ plugin, ...handlers }) {
    this.plugin = plugin;
    Object.assign(this, handlers);
    this.mode = 'off';
    this.suppressed = false;
    this.running = false; // 识别器正在听
    this.timer = 0;
    this.gen = 0;
    this.listeners = []; this.popup = capabilities.get(plugin)?.service === false; // 关掉后作废进行中的识别
  }

  /** 这台手机有没有可用的系统语音识别 */
  static async available(plugin) {
    let timer;
    try { const result = await Promise.race([plugin.available(), new Promise(resolve => { timer = setTimeout(() => resolve({ available: false }), 4000); })]); capabilities.set(plugin,result || {}); return Boolean(result?.available); } catch { return false; } finally { clearTimeout(timer); }
  }

  async enable() {
    this.disable();
    const generation = ++this.gen;
    this.suppressed = false;
    const perm = await this.plugin.checkPermissions().catch(() => null);
    if (generation !== this.gen) return 'off';
    if (perm?.speechRecognition !== 'granted') {
      const r = await this.plugin.requestPermissions().catch(() => null);
      if (generation !== this.gen) return 'off';
      if (r?.speechRecognition !== 'granted') throw new Error('麦克风权限被拒绝：请在手机设置里允许未央使用麦克风');
    }
    this.errors = 0;
    this.emptyResults = 0;
    if (this.plugin.addListener) {
      const entries = [['interim', e => this.onInterim?.(e.text || '')], ['energy', e => this.onEnergy?.(e.energy || 0)], ['state', e => {
        if (['ready', 'speech', 'processing'].includes(e.phase)) this.attempt?.ready();
        this.onStatus?.(e.phase);
      }]];
      for (const [name, fn] of entries) {
        const listener = await this.plugin.addListener(name,e => { if (this.mode !== 'off' && !this.suppressed) fn(e); });
        if (generation !== this.gen) { listener.remove?.(); return 'off'; }
        this.listeners.push(listener);
      }
    }
    this.#setMode('vad');
    this.onStatus?.('正在启动手机语音识别…');
    this.#schedule(0);
    return this.mode;
  }

  disable() {
    this.gen++;
    this.attempt?.cancel(); this.attempt = null;
    if (this.popup) globalThis.__jarvisSystemSpeechDialog = false;
    for (const listener of this.listeners.splice(0)) listener.remove?.();
    clearTimeout(this.timer);
    this.#setMode('off');
    if (this.running) this.plugin.stop().catch(() => {});
    this.running = false;
  }

  setSilenceMs() { /* 系统识别器自己判断停顿 */ }
  pttStart() {}
  pttEnd() {}

  /** 朗读期间暂停听（避免把自己的声音当成用户说话），朗读完接着听 */
  setSuppressed(on) {
    this.suppressed = on;
    if (on) {
      clearTimeout(this.timer);
      if (this.running) { this.gen++; this.attempt?.cancel(); this.attempt = null; this.running = false; this.plugin.stop().catch(() => {}); }
    } else this.#schedule(RESTART_MS);
  }

  #setMode(m) {
    this.mode = m;
    this.onMode?.(m);
  }

  #schedule(ms) {
    clearTimeout(this.timer);
    if (this.mode === 'off' || this.suppressed) return;
    this.timer = setTimeout(() => this.#listen(), ms);
  }

  async #listen() {
    if (this.mode === 'off' || this.suppressed || this.running) return;
    const gen = ++this.gen;
    this.running = true;
    let text = '';
    try {
      if (this.popup) globalThis.__jarvisSystemSpeechDialog = true;
      const attempt = this.attempt = nativeSpeechAttempt(this.plugin, { language: 'zh-CN', maxResults: 1, partialResults: false, popup: this.popup });
      const r = await attempt.promise;
      text = String(r?.matches?.[0] || '').trim();
      this.errors = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (gen !== this.gen || e?.name === 'AbortError') return;
      if (this.popup && QUIET_ERRORS.test(msg)) { this.disable(); return; }
      if (gen === this.gen && !QUIET_ERRORS.test(msg)) {
        if (!/权限|permission|denied/i.test(msg) && this.canFallback?.()) { this.disable(); this.onUnavailable?.(msg); return; }
        this.onError?.(`语音识别：${msg}`);
        if (!this.popup && !/权限|permission|denied/i.test(msg)) { this.popup = true; this.onStatus?.('popup'); this.#schedule(600); return; }
        if (++this.errors >= 3 || /权限|permission|denied|没有可用/i.test(msg)) {
          this.disable();
          if (!/权限|permission|denied/i.test(msg)) this.onUnavailable?.(msg);
          return;
        }
      }
    } finally {
      if (gen === this.gen) {
        if (this.popup) globalThis.__jarvisSystemSpeechDialog = false;
        this.running = false;
        this.attempt = null;
      }
    }
    if (gen !== this.gen || this.mode === 'off') return;
    if (text) {
      this.emptyResults = 0;
      this.onConfirm?.();
      this.onFinal?.(text);
    } else if (++this.emptyResults >= 3) {
      const message = '连续未识别到语音，请检查麦克风、靠近手机后重试，或在声音设置中选择云端识别';
      this.disable();
      if (this.canFallback?.()) this.onUnavailable?.(message);
      else this.onError?.(message);
      return;
    }
    if (this.popup && text) return; // 读完回复后再开启下一句，避免反复弹系统窗口
    this.#schedule(this.errors ? 1500 : RESTART_MS);
  }
}
