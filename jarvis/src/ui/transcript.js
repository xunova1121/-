/**
 * 对话记录 DOM。流式阶段用 textContent 追加纯文本；回复完成后按极简 Markdown 重排，
 * 全程只用 createElement + textContent，从不把模型输出当 HTML 插入。
 */
import { parseMarkdown } from '../core/markdown.js';

const LABEL = { user: '你', agent: '贾维斯' };

export function renderBlocks(container, text) {
  container.replaceChildren(...parseMarkdown(text).map((b) => {
    if (b.type === 'code') {
      // 代码块：语言标签 + 复制按钮
      const wrap = document.createElement('div');
      wrap.className = 'code';
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      const lang = document.createElement('span');
      lang.textContent = b.lang || 'text';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'code-copy';
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.text); copy.textContent = '已复制'; } catch {
          const r = document.createRange();
          r.selectNodeContents(pre);
          getSelection().removeAllRanges();
          getSelection().addRange(r);
          copy.textContent = '已选中，按 Ctrl+C';
        }
        setTimeout(() => { copy.textContent = '复制'; }, 1600);
      });
      bar.append(lang, copy);
      const pre = document.createElement('pre');
      pre.textContent = b.text;
      wrap.append(bar, pre);
      return wrap;
    }
    if (b.type === 'heading') {
      const h = document.createElement(`h${b.level + 2}`);
      h.append(...b.spans.map(span));
      return h;
    }
    if (b.type === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      const table = document.createElement('table');
      b.rows.forEach((r, i) => {
        const tr = document.createElement('tr');
        for (const c of r) {
          const cell = document.createElement(i === 0 ? 'th' : 'td');
          cell.textContent = c;
          tr.append(cell);
        }
        table.append(tr);
      });
      wrap.append(table);
      return wrap;
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

export function toolLabel(name) {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
  if (name.startsWith('mcp_')) return `MCP · ${name.split('__').pop()}`;
  return name;
}

const TOOL_LABEL = {
  remember: '记住', recall: '回忆', forget: '遗忘', save_skill: '习得技能', kb_search: '检索知识库',
  list_files: '列出文件', read_file: '读取文件', write_file: '写入文件', create_document: '生成文档',
  run_javascript: '运行 JS', run_python: '运行 Python', preview: '打开预览', fetch_url: '读取网页',
  web_search: '联网搜索', deep_research: '深度调研', get_current_time: '读取时间', get_local_metrics: '读取系统状态',
  use_skill: '使用技能', read_skill_file: '读取技能文件', schedule_task: '创建定时任务', list_schedules: '查看定时任务', cancel_schedule: '删除定时任务', core_memory_update: '更新核心记忆',
  computer_list_dir: '查看文件夹', computer_read_file: '读取电脑文件', computer_write_file: '写入电脑文件', computer_save_from_workspace: '保存到电脑',
  computer_move: '移动 / 重命名', computer_copy: '复制文件', computer_trash: '移到回收站', computer_search: '搜索文件', computer_open: '打开',
  computer_run: '运行命令', computer_screenshot: '截屏', clipboard_read: '读剪贴板', clipboard_write: '写剪贴板', computer_notify: '系统通知'
};

function summarizeArgs(name, a = {}) {
  if (a.path) return a.path;
  if (a.query) return a.query;
  if (a.question) return a.question;
  if (a.url) return a.url;
  if (a.content) return a.content.slice(0, 60);
  if (a.code) return a.code.split('\n')[0].slice(0, 60);
  if (a.name) return a.name;
  if (a.command) return a.command.slice(0, 80);
  if (a.target) return a.target;
  if (a.from) return `${a.from} → ${a.to ?? ''}`;
  const json = JSON.stringify(a);
  return json === '{}' ? '' : json.slice(0, 80);
}

/** 👍 / 👎：👎 时展开一行输入框，让用户说明哪里不好，这会成为“经验教训” */
function feedbackButtons(meta, onFeedback) {
  const box = document.createElement('span');
  box.className = 'feedback';
  const up = Object.assign(document.createElement('button'), { type: 'button', title: '有帮助', textContent: '👍' });
  const down = Object.assign(document.createElement('button'), { type: 'button', title: '不满意：告诉我哪里不好，我会记住', textContent: '👎' });
  up.addEventListener('click', () => {
    up.setAttribute('aria-pressed', 'true');
    down.disabled = true;
    onFeedback('up');
  });
  down.addEventListener('click', () => {
    if (meta.parentElement.querySelector('.lesson-box')) return;
    const form = document.createElement('form');
    form.className = 'lesson-box';
    const input = Object.assign(document.createElement('input'), { placeholder: '哪里不好？例如：太啰嗦 / 应该先问清需求 / 数据错了', maxLength: 200 });
    const ok = Object.assign(document.createElement('button'), { type: 'submit', className: 'btn sm', textContent: '记下教训' });
    form.append(input, ok);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      down.setAttribute('aria-pressed', 'true');
      up.disabled = true;
      onFeedback('down', input.value.trim());
      form.remove();
    });
    meta.after(form);
    input.focus();
  });
  box.append(up, down);
  return box;
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export class Transcript {
  constructor(root) {
    this.root = root;
    this.interimEl = null;
  }

  /**
   * @param {'user'|'agent'} role
   * @returns 气泡控制对象：append / done / toolCard / sources / feedback
   */
  add(role, text = '', ts = Date.now(), { thumbs = [] } = {}) {
    this.clearInterim();
    this.root.querySelector('.welcome')?.remove();
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const head = document.createElement('span');
    head.className = 'who';
    head.textContent = `${LABEL[role] ?? role} · ${hhmm(ts)}`;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    el.append(head, body);
    if (thumbs?.length) {
      const row = document.createElement('div');
      row.className = 'msg-images';
      for (const src of thumbs) row.append(Object.assign(document.createElement('img'), { src, alt: '附带的图片', loading: 'lazy' }));
      el.insertBefore(row, body);
    }
    this.root.append(el);
    this.#scroll();
    let raw = text;
    // 文字与工具卡片按时间顺序交替出现：每段文字一个独立的 body
    let cur = body;
    let curRaw = text;
    const self = this;
    return {
      el,
      get text() { return raw; },
      append(d) {
        raw += d;
        curRaw += d;
        cur.textContent = curRaw;
        self.#scroll();
      },
      /** 工具执行卡片：执行中显示动画，结束后可展开查看输出 */
      toolCard(name, args) {
        if (role === 'agent' && curRaw) renderBlocks(cur, curRaw);
        const card = document.createElement('details');
        card.className = 'tool-card';
        const sum = document.createElement('summary');
        const st = document.createElement('span'); st.className = 'st';
        const tn = document.createElement('span'); tn.className = 'tn'; tn.textContent = toolLabel(name);
        const ta = document.createElement('span'); ta.className = 'ta'; ta.textContent = summarizeArgs(name, args);
        const tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = '…';
        sum.append(st, tn, ta, tm);
        const pre = document.createElement('pre');
        card.append(sum, pre);
        el.append(card);
        const next = document.createElement('div');
        next.className = 'body';
        el.append(next);
        cur = next;
        curRaw = '';
        self.#scroll();
        let log = '';
        return {
          progress(text) {
            card.classList.add('live');
            log += `${log ? '\n' : ''}· ${text}`;
            pre.textContent = log;
            tm.textContent = text.slice(0, 24);
            self.#scroll();
          },
          done(ok, output, ms) {
            card.classList.remove('live');
            card.classList.add(ok ? 'ok' : 'fail');
            tm.textContent = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
            pre.textContent = log ? `${log}\n\n${output}` : output;
            self.#scroll();
          }
        };
      },
      /**
       * 征求同意：在气泡里显示确认卡片。
       * @returns {Promise<'once'|'session'|'deny'>}
       */
      confirm({ title, detail }) {
        const box = document.createElement('div');
        box.className = 'confirm-card';
        const h = document.createElement('div');
        h.className = 'confirm-title';
        h.textContent = title;
        box.append(h);
        if (detail) {
          const pre = document.createElement('pre');
          pre.textContent = detail;
          box.append(pre);
        }
        const row = document.createElement('div');
        row.className = 'confirm-actions';
        box.append(row);
        el.insertBefore(box, cur);
        self.#scroll();
        return new Promise((resolve) => {
          const done = (v, label) => {
            row.replaceChildren(Object.assign(document.createElement('span'), { className: `confirm-result ${v === 'deny' ? 'no' : 'yes'}`, textContent: label }));
            box.classList.add('answered');
            resolve(v);
          };
          for (const [v, label, cls, result] of [['once', '允许', 'btn sm', '已允许'], ['session', '本次都允许', 'btn ghost sm', '已允许（本次会话不再询问）'], ['deny', '拒绝', 'btn ghost sm danger', '已拒绝']]) {
            const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label });
            b.addEventListener('click', () => done(v, result));
            row.append(b);
          }
          row.querySelector('button').focus({ preventScroll: true });
          box.cancel = () => done('deny', '已取消');
        });
      },
      sources(names) {
        const box = document.createElement('div');
        box.className = 'sources';
        box.append('参考：', ...[...new Set(names)].map((n) => Object.assign(document.createElement('span'), { textContent: n })));
        el.insertBefore(box, el.children[1]);
      },
      done(meta, { onFeedback } = {}) {
        el.classList.remove('streaming');
        if (role === 'agent' && curRaw) renderBlocks(cur, curRaw);
        for (const b of el.querySelectorAll('.body')) if (!b.textContent.trim() && !b.children.length) b.remove();
        const m = document.createElement('div');
        m.className = 'meta';
        if (meta) m.append(meta);
        if (onFeedback) m.append(feedbackButtons(m, onFeedback));
        if (meta || onFeedback) el.append(m);
        self.#scroll();
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
