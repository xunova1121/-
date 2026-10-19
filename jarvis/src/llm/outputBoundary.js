/** 只隔离显式推理标签和已知的内部草稿开头，不按语言过滤正常英文、代码。 */
export class OutputBoundary {
  constructor() {
    this.pending = '';
    this.hidden = false;
    this.code = false;
    this.checked = false;
  }

  push(fragment) {
    this.pending += String(fragment || '');
    if (!this.checked) {
      const start = this.pending.trimStart().toLowerCase();
      const prefixes = ['the user said', 'the user asked', 'the user is asking', 'let me think', 'let me reason', 'let me analyze', 'let me analyse'];
      const candidate = !start || prefixes.some((prefix) => prefix.startsWith(start) || start.startsWith(prefix));
      if (candidate && this.pending.length < 512) return '';
      this.checkDraft();
      this.checked = true;
    }
    return this.drain(false);
  }

  checkDraft() {
    const internalStart = /^\s*(?:The user (?:said|asked|is asking)|Let me (?:think|reason|analy[sz]e))/i.test(this.pending);
    if (internalStart && /\b(?:I need to|I searched|let me reconsider|but wait|the summary says|from the search results)\b/i.test(this.pending)) {
      throw Object.assign(new Error('模型返回了分析草稿，未作为正式回答显示'), { name: 'ModelOutputError', code: 'ANALYSIS_IN_OUTPUT', kind: 'api' });
    }
  }

  drain(final) {
    let visible = '';
    while (this.pending) {
      if (this.pending.startsWith('```')) {
        this.code = !this.code;
        if (!this.hidden) visible += '```';
        this.pending = this.pending.slice(3);
        continue;
      }
      if (!this.code && this.pending[0] === '<') {
        const tag = this.pending.match(/^<\/?(?:think|thinking|analysis|reasoning)\s*>/i);
        if (tag) {
          this.hidden = !/^<\//.test(tag[0]);
          this.pending = this.pending.slice(tag[0].length);
          continue;
        }
        if (!final && /^<\/?[a-z]*\s*$/i.test(this.pending) && this.pending.length < 24) break;
      }
      if (!final && this.pending.length < 3 && /^`+$/.test(this.pending)) break;
      if (!this.hidden) visible += this.pending[0];
      this.pending = this.pending.slice(1);
    }
    return visible;
  }

  flush() {
    this.checkDraft();
    const result = this.drain(true);
    if (this.hidden)
      throw Object.assign(new Error('模型只有未闭合的分析块，缺少正式回答'), { name: 'ModelOutputError', code: 'ANALYSIS_IN_OUTPUT', kind: 'api' });
    return result;
  }
}
