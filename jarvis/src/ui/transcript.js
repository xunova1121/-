/**
 * 对话记录 DOM。流式阶段用 textContent 追加纯文本；回复完成后按极简 Markdown 重排，
 * 全程只用 createElement + textContent，从不把模型输出当 HTML 插入。
 */
import { parseMarkdown } from '../core/markdown.js';

const LABEL = { user: '你', agent: '贾维斯' };

export function renderBlocks(container, text) {
  container.replaceChildren(...parseMarkdown(text).map((b) => {
    if (b.type === 'code') {
      const pre = document.createElement('pre');
      pre.textContent = b.text;
      return pre;
    }
    if (b.type === 'list') {
      const list = document.createElement(b.ordered ? 'ol' : 'ul');
      for (const spans of b.items) {
        const li = document.createElement('li');
        li.append(...spans.map(span));
        list.append(li);
      }
      return list;
    }
    const p = document.createElement('p');
    p.append(...b.spans.map(span));
    return p;
  }));
}

function span(s) {
  if (!s.bold && !s.code) return document.createTextNode(s.text);
  const el = document.createElement(s.code ? 'code' : 'strong');
  el.textContent = s.text;
  return el;
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export class Transcript {
  constructor(root) {
    this.root = root;
    this.interimEl = null;
  }

  add(role, text = '', ts = Date.now()) {
    this.clearInterim();
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const head = document.createElement('span');
    head.className = 'who';
    head.textContent = `${LABEL[role] ?? role} · ${hhmm(ts)}`;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    el.append(head, body);
    this.root.append(el);
    this.#scroll();
    let raw = text;
    return {
      el,
      append: (d) => { raw += d; body.textContent = raw; this.#scroll(); },
      done: (meta) => {
        el.classList.remove('streaming');
        if (role === 'agent' && raw) renderBlocks(body, raw);
        if (meta) {
          const m = document.createElement('span');
          m.className = 'meta';
          m.textContent = meta;
          el.append(m);
        }
        this.#scroll();
      }
    };
  }

  /** 语音识别的中间结果，显示为半透明的临时气泡 */
  interim(text) {
    if (!this.interimEl) {
      this.interimEl = document.createElement('div');
      this.interimEl.className = 'msg user interim';
      this.root.append(this.interimEl);
    }
    this.interimEl.textContent = text || '…';
    this.#scroll();
  }

  clearInterim() {
    this.interimEl?.remove();
    this.interimEl = null;
  }

  #scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}
