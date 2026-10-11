/** 对话记录 DOM。用 textContent 写入，杜绝把模型输出当 HTML 插入。 */
export class Transcript {
  constructor(root) {
    this.root = root;
    this.interimEl = null;
  }

  add(role, text = '') {
    this.clearInterim();
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    this.root.append(el);
    this.#scroll();
    return {
      el,
      append: (d) => { el.textContent += d; this.#scroll(); },
      set: (t) => { el.textContent = t; },
      done: (meta) => {
        el.classList.remove('streaming');
        if (meta) {
          const m = document.createElement('span');
          m.className = 'meta';
          m.textContent = meta;
          el.append(m);
        }
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
