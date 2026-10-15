/**
 * 安卓 App 的“直接对话”：用手机系统自带的语音识别（免费、不需要密钥，中文由手机厂商的识别服务提供）。
 * 系统识别器自己判断一句话什么时候说完，所以不需要网页里的语音活动检测模型。
 * 循环：开始听 → 说完拿到文字 → 交给对话 → 未央朗读期间暂停（免得听到自己）→ 接着听。
 * 和 VoiceInput 的接口一致，main.js 不用区分。
 */
const RESTART_MS = 350;
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
    this.gen = 0; // 关掉后作废进行中的识别
  }

  /** 这台手机有没有可用的系统语音识别 */
  static async available(plugin) {
    let timer;
    try { return Boolean((await Promise.race([plugin.available(), new Promise(resolve => { timer = setTimeout(() => resolve({ available: false }), 4000); })]))?.available); } catch { return false; } finally { clearTimeout(timer); }
  }

  async enable() {
    const perm = await this.plugin.checkPermissions().catch(() => null);
    if (perm?.speechRecognition !== 'granted') {
      const r = await this.plugin.requestPermissions().catch(() => null);
      if (r?.speechRecognition !== 'granted') throw new Error('麦克风权限被拒绝：请在手机设置里允许未央使用麦克风');
    }
    this.errors = 0;
    this.#setMode('vad');
    this.#schedule(0);
    return this.mode;
  }

  disable() {
    this.gen++;
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
      if (this.running) { this.gen++; this.running = false; this.plugin.stop().catch(() => {}); }
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
      const r = await this.plugin.start({ language: 'zh-CN', maxResults: 1, partialResults: false, popup: false });
      text = String(r?.matches?.[0] || '').trim();
      this.errors = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (gen === this.gen && !QUIET_ERRORS.test(msg)) {
        this.onError?.(`语音识别：${msg}`);
        if (++this.errors >= 3 || /权限|没有可用/.test(msg)) { this.disable(); return; }
      }
    } finally {
      if (gen === this.gen) this.running = false;
    }
    if (gen !== this.gen || this.mode === 'off') return;
    if (text) {
      this.onConfirm?.();
      this.onFinal?.(text);
    }
    this.#schedule(this.errors ? 1500 : RESTART_MS);
  }
}
