/**
 * 把 LLM 流式文本切成可朗读的句子（需求 6.1：凑够一句就送进 speechSynthesis 队列）。
 *
 * 句末标点立即切分；一句过长（> maxLen）时在逗号处提前切，减少首句等待。
 */
const HARD = /[。！？!?；;\n]/;
const SOFT = /[，,、：:]/;

export class SentenceChunker {
  constructor({ maxLen = 60 } = {}) {
    this.buf = '';
    this.maxLen = maxLen;
  }

  push(delta) {
    this.buf += delta;
    const out = [];
    for (;;) {
      let cut = -1;
      for (let i = 0; i < this.buf.length; i++) {
        const ch = this.buf[i];
        // 英文句点后跟空白才算句末，避免切断 3.14 / v2.0
        if (HARD.test(ch) || (ch === '.' && /\s/.test(this.buf[i + 1] ?? 'x'))) { cut = i; break; }
        if (i >= this.maxLen && SOFT.test(ch)) { cut = i; break; }
      }
      if (cut < 0) break;
      const s = clean(this.buf.slice(0, cut + 1));
      this.buf = this.buf.slice(cut + 1);
      if (s) out.push(s);
    }
    return out;
  }

  flush() {
    const s = clean(this.buf);
    this.buf = '';
    return s ? [s] : [];
  }
}

/** 去掉不适合朗读的 Markdown 记号 */
export function clean(s) {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}
