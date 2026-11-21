/**
 * VAD → 语音识别的时序门控（需求 6.2），纯逻辑、按帧驱动，便于单测。
 *
 *   说话开始 ──(+startDelay 300ms 仍在说)──▶ confirm：确认为有效语句（切“聆听”、界面显示识别中）
 *   有效语句 ──(静默持续 silenceMs 800ms)──▶ commit：停止识别并提交
 *   300ms 内就停了 ──▶ cancel：当作“嗯/咳嗽”这类误触发，丢弃
 *
 * onset 回调在说话一开始就触发，调用方可借此提前打开识别器（pre-roll），
 * 不会因为 300ms 的确认延迟吃掉第一个音节。
 *
 * 概率用迟滞阈值判定：> positive 进入说话，< negative 才算静默，避免在阈值附近抖动。
 */
export class VadGate {
  constructor({
    startDelay = 300,
    silenceMs = 800,
    positive = 0.5,
    negative = 0.35,
    onOnset,
    onConfirm,
    onCancel,
    onCommit
  } = {}) {
    Object.assign(this, { startDelay, silenceMs, positive, negative, onOnset, onConfirm, onCancel, onCommit });
    this.speaking = false;
    this.phase = 'idle'; // idle | pending | active
    this.onsetAt = 0;
    this.silentSince = 0;
  }

  /** 每个音频帧调用一次：prob 为语音概率，t 为毫秒时间戳 */
  update(prob, t) {
    if (!this.speaking && prob > this.positive) this.speaking = true;
    else if (this.speaking && prob < this.negative) this.speaking = false;

    if (this.phase === 'idle') {
      if (this.speaking) {
        this.phase = 'pending';
        this.onsetAt = t;
        this.onOnset?.();
      }
    } else if (this.phase === 'pending') {
      if (!this.speaking) {
        this.phase = 'idle';
        this.onCancel?.();
      } else if (t - this.onsetAt >= this.startDelay) {
        this.phase = 'active';
        this.silentSince = 0;
        this.onConfirm?.();
      }
    } else if (this.phase === 'active') {
      if (this.speaking) this.silentSince = 0;
      else {
        if (!this.silentSince) this.silentSince = t;
        if (t - this.silentSince >= this.silenceMs) {
          this.phase = 'idle';
          this.onCommit?.();
        }
      }
    }
    return this.phase;
  }

  reset() {
    this.speaking = false;
    this.phase = 'idle';
  }
}

/** VAD 灵敏度 → 静默阈值（需求 9.4） */
export const SILENCE_BY_SENSITIVITY = { 低: 1200, 中: 800, 高: 500 };
