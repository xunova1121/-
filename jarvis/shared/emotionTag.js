/**
 * 从模型输出开头剥离 <emotion>X</emotion> 标签，转成 emotion_hint 字段（需求 7.1）。
 *
 * 现在提示词已经不要求模型写标签（写了容易漏到界面上）；有的模型、旧对话仍会写，这里照样剥掉：
 *   - 读到完整标签、且后面有了正文 → 取出情绪，剩余文本照常下发；
 *   - 开头不像标签、或缓冲超过 48 字 → 原样下发，界面由关键词规则判断表情。
 */
export const EMOTIONS = ['平静', '专注', '聆听', '亲和', '安抚', '愉悦', '警觉'];
const MAX_PREFIX = 48;
const NAMES = EMOTIONS.join('|');
/**
 * 回答开头的情绪标签，模型会写成各种样子，都要认出来（这些曾经漏到界面上过）：
 *   <emotion>专注</emotion>、<emotion>focused</emotion>、标签和内容分成几行、写错结尾（<emotion>专注>）、
 *   <专注>、【专注】、[专注]、（专注）、<emotion=专注>、<emotion 专注>、(emotion: 专注)、emotion：专注、全角＜＞
 */
const LEAD = new RegExp(
  '^\\s*(?:' +
    // <emotion>X</emotion> 及写错结尾；X 可以是中文或英文（最多 20 字），可以单独占一行
    '[<＜]\\s*emotion\\s*[>＞]\\s*([^<>＜＞\\n]{1,20}?)\\s*(?:[<＜]\\s*\\/?\\s*emotion\\s*[>＞]|[>＞]|\\n(?!\\s*[<＜]))' +
    '|[<＜]\\s*emotion\\s*[=:：\\s]\\s*([^<>＜＞\\n]{1,20}?)\\s*[>＞]' +
    `|[<＜【\\[（(]\\s*(?:emotion\\s*[:：=]\\s*)?(${NAMES})\\s*[>＞】\\]）)]` +
    `|emotion\\s*[:：]\\s*(${NAMES})(?=\\s)` +
  ')\\s*',
  'i'
);
/** 开头是不是一个（可能还没写完的）情绪标签：是就返回 { hint, rest } */
function leadTag(text) {
  const m = text.match(LEAD);
  if (!m) return null;
  const word = (m[1] || m[2] || m[3] || m[4] || '').trim();
  return { hint: EMOTIONS.includes(word) ? word : null, rest: text.slice(m[0].length) };
}
/** 还可能长成一个标签吗（流式输出时先别放行） */
function mayBeTag(t) {
  if (/^[<＜]\s*\/?\s*e(?:m(?:o(?:t(?:i(?:o(?:n)?)?)?)?)?)?$/i.test(t)) return true; // <emo… 还没写完
  if (/^[<＜]\s*emotion/i.test(t)) return true; // <emotion…：等结尾
  if (/^e(?:m(?:o(?:t(?:i(?:o(?:n)?)?)?)?)?)?\s*[:：]?\s*$/i.test(t) || /^emotion\s*[:：]\s*\S{0,3}$/i.test(t)) return true;
  // 括号开头：括号还没合上、里面可能是情绪词时先等；已经合上（如 [1]、(注)）就不是
  return /^[<＜【\[（(]\s*(?:emotion\s*[:：=]?\s*)?[^>＞】\]）)\n]{0,4}$/i.test(t);
}

export class EmotionTagStripper {
  constructor() {
    this.buf = '';
    this.decided = false;
  }

  /** @returns {{ text: string, hint: string | null }} */
  push(delta) {
    if (this.decided) return { text: delta, hint: null };
    this.buf += delta;
    const t = this.buf.replace(/^\s+/, '');
    if (!t) return { text: '', hint: null };
    const tag = leadTag(t);
    // 标签完整、而且后面已经有正文了才放行（不然标签内容可能还在下一段里）
    if (tag && tag.rest.trim()) return this.#release(tag.hint, tag.rest.replace(/^\s+/, ''));
    if (tag) return t.length > MAX_PREFIX ? this.#release(tag.hint, '') : { text: '', hint: null };
    if (mayBeTag(t) && t.length <= MAX_PREFIX) return { text: '', hint: null };
    return this.#release(null, this.buf);
  }

  /** 流结束时把没判定完的缓冲吐出来 */
  flush() {
    if (this.decided) return { text: '', hint: null };
    const tag = leadTag(this.buf.replace(/^\s+/, ''));
    return tag ? this.#release(tag.hint, tag.rest.replace(/^\s+/, '')) : this.#release(null, this.buf);
  }

  #release(hint, text) {
    this.decided = true;
    this.buf = '';
    return { text, hint };
  }
}

/** 正文里残留的情绪标签（开头、每段开头、任何位置的 emotion 标签）一律去掉 */
export function stripEmotionTags(s) {
  let out = String(s ?? '');
  for (let i = 0; i < 3; i++) {
    const tag = leadTag(out);
    if (!tag) break;
    out = tag.rest;
  }
  return out
    .replace(/[<＜]\s*emotion\s*[>＞]\s*(?:[^<>＜＞\n]{0,20}?\s*[<＜]\s*\/?\s*emotion\s*[>＞]|[^<>＜＞\s]{0,8}\s*[>＞])\s*/gi, '')
    .replace(new RegExp(`(^|\\n)[ \\t]*(?:[<＜]\\s*(?:${NAMES})\\s*[>＞]|[【\\[]\\s*(?:${NAMES})\\s*[】\\]])[ \\t]*`, 'g'), '$1')
    .replace(/[<＜]\s*\/?\s*emotion\s*[>＞]/gi, '');
}

/** 表情对应的小图标（显示在“未央 · 时间”旁边） */
export const EMOTION_ICON = { 平静: '🙂', 专注: '🧐', 聆听: '👂', 亲和: '😊', 安抚: '🤗', 愉悦: '😄', 警觉: '⚠️' };
