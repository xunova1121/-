/**
 * 唤醒词：“贾维斯” / “Jarvis”。语音识别常把它写成同音字，这里一并认。
 * 唤醒后保持一段“对话窗口”，期间接着说不用再喊名字。
 */
const NAME = '(?:[贾嘉佳加家甲][维唯伟威卫][斯丝思司四]|jarvis|jervis|javis)';
const LEAD = '^[\\s，,。.!！?？、]*(?:(?:嘿|嗨|hey|hi|hello|你好|喂|哎)[\\s，,、]*)?';
const WAKE_RE = new RegExp(`${LEAD}${NAME}[\\s，,。.!！?？、:：]*`, 'i');
const ANYWHERE_RE = new RegExp(NAME, 'i');

/**
 * @param {string} text 识别结果
 * @returns {{ woke: boolean, rest: string }} rest 为去掉唤醒词后的指令
 */
export function matchWake(text) {
  const t = String(text || '').trim();
  const m = t.match(WAKE_RE);
  if (m) return { woke: true, rest: t.slice(m[0].length).trim() };
  // 名字出现在句中（“帮我查下天气贾维斯”）也算唤醒，整句作为指令
  if (ANYWHERE_RE.test(t)) return { woke: true, rest: t.replace(new RegExp(`[\\s，,]*${NAME}[\\s，,。.!！?？]*`, 'i'), ' ').trim() };
  return { woke: false, rest: t };
}

export class WakeWindow {
  constructor({ windowMs = 20000, now = () => performance.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.until = 0;
  }
  get awake() { return this.now() < this.until; }
  /** 唤醒或续期 */
  wake() { this.until = this.now() + this.windowMs; }
  sleep() { this.until = 0; }
}
