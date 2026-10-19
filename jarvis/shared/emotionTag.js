/**
 * 从模型输出开头剥离 <emotion>X</emotion> 标签，转成 emotion_hint 字段（需求 7.1）。
 *
 * 模型被要求在回复最开头写一个标签，表示“界面应采用的表达风格”。网关逐 token 缓冲开头部分：
 *   - 读到完整标签 → 取出情绪，剩余文本照常下发；
 *   - 开头不是 "<"、或缓冲超过 48 字仍未闭合 → 判定模型没写标签，原样下发，由前端关键词规则兜底。
 */
export const EMOTIONS = ['平静', '专注', '聆听', '亲和', '安抚', '愉悦', '警觉'];
const MAX_PREFIX = 48;

export class EmotionTagStripper {
  constructor() {
    this.buf = '';
    this.decided = false;
  }

  /** @returns {{ text: string, hint: string | null }} */
  push(delta) {
    if (this.decided) return { text: delta, hint: null };
    this.buf += delta;
    const trimmed = this.buf.replace(/^\s+/, '');
    if (!trimmed) return { text: '', hint: null };
    // 兼容模型省略 emotion 外壳的七种已知情绪；只缓冲可能的前缀，不吞正文或 HTML。
    const short = trimmed.match(/^<\s*(平静|专注|聆听|亲和|安抚|愉悦|警觉)\s*>\s*/);
    if (short) return this.#release(short[1], trimmed.slice(short[0].length));
    if (EMOTIONS.some(e => ('<' + e + '>').startsWith(trimmed))) return { text: '', hint: null };
    // 开头既不是 "<emotion>" 的前缀、也不以它开头 → 模型没写标签
    if (!'<emotion>'.startsWith(trimmed.slice(0, 9))) {
      return this.#release(null, this.buf);
    }
    // 标准写法 <emotion>平静</emotion>；模型偶尔写错结尾（<emotion>平静>、<emotion>平静<emotion>、<emotion>平静 换行），也一并去掉
    const m = trimmed.match(/^<emotion>\s*([^<>\s]{0,8})\s*(?:<\s*\/\s*emotion\s*>|<\s*emotion\s*>|>|\n)\s*/i);
    if (m) {
      const hint = EMOTIONS.includes(m[1]) ? m[1] : null;
      return this.#release(hint, trimmed.slice(m[0].length));
    }
    if (trimmed.length > MAX_PREFIX) return this.#release(null, this.buf);
    return { text: '', hint: null };
  }

  /** 流结束时把没判定完的缓冲吐出来 */
  flush() {
    if (this.decided) return { text: '', hint: null };
    return this.#release(null, this.buf);
  }

  #release(hint, text) {
    this.decided = true;
    this.buf = '';
    return { text, hint };
  }
}

/** 正文里残留的情绪标签（任何位置、各种写错的形式）一律去掉 */
export function stripEmotionTags(s) {
  return String(s ?? '').replace(/^\s*<\s*(?:平静|专注|聆听|亲和|安抚|愉悦|警觉)\s*>\s*/, '').replace(/<\s*\/?\s*emotion\s*>\s*(?:[^<>\s]{0,8}\s*(?:<\s*\/\s*emotion\s*>|>))?/gi, '');
}

/** 表情对应的小图标（显示在“未央 · 时间”旁边） */
export const EMOTION_ICON = { 平静: '🙂', 专注: '🧐', 聆听: '👂', 亲和: '😊', 安抚: '🤗', 愉悦: '😄', 警觉: '⚠️' };
