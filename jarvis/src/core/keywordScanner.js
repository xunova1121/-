import { EMOTION_KEYWORDS } from './emotions.js';

export const WINDOW_CHARS = 200;

/**
 * 在文本窗口内给每种情绪打分。越靠近窗口末尾（越新）的命中权重越高，
 * 这样同一窗口里先“抱歉出现错误”、后“没关系，已经恢复”时，后者胜出。
 * 返回得分最高的情绪；没有任何命中时返回 null。
 */
export function scoreWindow(text, keywords = EMOTION_KEYWORDS) {
  const win = text.length > WINDOW_CHARS ? text.slice(-WINDOW_CHARS) : text;
  const len = Math.max(win.length, 1);
  let best = null;
  let bestScore = 0;
  for (const [emotion, words] of Object.entries(keywords)) {
    let score = 0;
    for (const w of words) {
      let from = 0;
      for (;;) {
        const at = win.indexOf(w, from);
        if (at < 0) break;
        score += 1 + (at + w.length) / len;
        from = at + w.length;
      }
    }
    if (score > bestScore) {
      best = emotion;
      bestScore = score;
    }
  }
  return best;
}
