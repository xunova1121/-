import { isEmotion } from './emotions.js';
import { scoreWindow, WINDOW_CHARS } from './keywordScanner.js';

/**
 * 情绪状态机 —— 规则引擎（需求 4.1、6.3）。
 *
 * 优先级（高 → 低）：
 *   0. 手动锁定           setManual()
 *   1. API 显式注入       setStreamHint()（流式消息里的 emotion_hint，本轮有效）
 *                         inject()（POST /api/agent/emotion，ttl 到期回落）
 *   2. 文本关键词         feedResponseText()，候选需持续 ≥ 800ms 才生效
 *   3. 任务状态推断       setTaskState()
 *
 * 只吃文本、API 指令和任务状态；不接收摄像头或音频的任何特征。
 * 不依赖真实时钟：时间由构造参数 now() 注入，调用方负责周期性 tick()。
 */
export const TASK_DEFAULT = {
  idle: '平静',
  listening: '聆听',
  processing: '专注',
  error: '警觉',
  done: '亲和'
};

export class EmotionMachine {
  constructor({ now = () => performance.now(), holdMs = 800, afterglowMs = 3000, onChange } = {}) {
    this.now = now;
    this.holdMs = holdMs;
    this.afterglowMs = afterglowMs;
    this.onChange = onChange;

    this.manual = null;
    this.streamHint = null;
    this.injected = null; // { state, until }
    this.keyword = null; // 已生效的关键词情绪
    this.candidate = null; // { emotion, since }
    this.responseText = '';
    this.task = 'idle';
    this.doneAt = 0;

    this.state = '平静';
    this.source = 'task';
  }

  /** 手动锁定；传 null 即“自动”，解除锁定 */
  setManual(emotion) {
    this.manual = isEmotion(emotion) ? emotion : null;
    return this.tick();
  }

  setStreamHint(emotion) {
    if (isEmotion(emotion)) this.streamHint = emotion;
    return this.tick();
  }

  inject(emotion, ttlMs = 5000) {
    if (!isEmotion(emotion)) return this.state;
    this.injected = { state: emotion, until: this.now() + Math.max(0, ttlMs) };
    return this.tick();
  }

  /** 新一轮用户输入开始（VAD 检测到说话 / 文本框开始输入）：清掉上一轮的提示与关键词 */
  beginUserTurn() {
    this.streamHint = null;
    this.keyword = null;
    this.candidate = null;
    this.responseText = '';
    return this.setTaskState('listening');
  }

  /** 累积 LLM 流式响应文本，每个 token 后重新评估最近 200 字 */
  feedResponseText(delta) {
    this.responseText = (this.responseText + delta).slice(-WINDOW_CHARS);
    const hit = scoreWindow(this.responseText);
    const t = this.now();
    if (!hit) this.candidate = null;
    else if (!this.candidate || this.candidate.emotion !== hit) this.candidate = { emotion: hit, since: t };
    return this.tick();
  }

  setTaskState(task) {
    if (!(task in TASK_DEFAULT)) return this.state;
    this.task = task;
    if (task === 'done') this.doneAt = this.now();
    if (task === 'done' || task === 'error') {
      // 回合结束：本轮的流式提示和关键词不再延续到下一轮
      this.streamHint = null;
      this.keyword = null;
      this.candidate = null;
      this.responseText = '';
    }
    return this.tick();
  }

  /** 重新求值；返回当前情绪。状态变化时回调 onChange(state, source) */
  tick() {
    const t = this.now();
    if (this.injected && t >= this.injected.until) this.injected = null;
    if (this.candidate && t - this.candidate.since >= this.holdMs) this.keyword = this.candidate.emotion;
    if (this.task === 'done' && t - this.doneAt >= this.afterglowMs) this.task = 'idle';

    let next;
    let source;
    if (this.manual) [next, source] = [this.manual, 'manual'];
    else if (this.injected) [next, source] = [this.injected.state, 'inject'];
    else if (this.streamHint) [next, source] = [this.streamHint, 'hint'];
    else if (this.keyword) [next, source] = [this.keyword, 'keyword'];
    else [next, source] = [TASK_DEFAULT[this.task], 'task'];

    if (next !== this.state || source !== this.source) {
      const changed = next !== this.state;
      this.state = next;
      this.source = source;
      if (changed) this.onChange?.(next, source);
    }
    return this.state;
  }
}
