/**
 * 对话记录 DOM。流式阶段用 textContent 追加纯文本；回复完成后按极简 Markdown 重排，
 * 全程只用 createElement + textContent，从不把模型输出当 HTML 插入。
 */
import { parseMarkdown } from '../core/markdown.js';

const LABEL = { user: '你', agent: '未央' };

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
  generate_image: '画图', generate_video: '生成视频', copy_skill_file: '复制技能文件', show_image: '显示图片',
  use_skill: '使用技能', read_skill_file: '读取技能文件', schedule_task: '创建定时任务', list_schedules: '查看定时任务', cancel_schedule: '删除定时任务', core_memory_update: '更新核心记忆',
  computer_list_dir: '查看文件夹', computer_read_file: '读取电脑文件', computer_write_file: '写入电脑文件', computer_save_from_workspace: '保存到电脑',
  computer_move: '移动 / 重命名', computer_copy: '复制文件', computer_trash: '移到回收站', computer_search: '搜索文件', computer_open: '打开',
  computer_run: '运行命令', computer_screenshot: '截屏', computer_look: '看屏幕', computer_click: '点击', computer_type: '键盘输入', computer_key: '按键', computer_scroll: '滚动', computer_drag: '拖动', clipboard_read: '读剪贴板', clipboard_write: '写剪贴板', computer_notify: '系统通知'
};

export function summarizeArgs(name, a = {}) {
  if (a.path) return a.path;
  if (a.query) return a.query;
  if (a.question) return a.question;
  if (a.keys) return a.keys;
  if (typeof a.x === 'number') return `(${a.x}, ${a.y})${a.to_x !== undefined ? ` → (${a.to_x}, ${a.to_y})` : ''}`;
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
  const thumb = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
  const up = Object.assign(document.createElement('button'), { type: 'button', title: '有帮助', innerHTML: thumb });
  const down = Object.assign(document.createElement('button'), { type: 'button', className: 'down', title: '不满意：告诉我哪里不好，我会记住', innerHTML: thumb });
  up.setAttribute('aria-label', '有帮助');
  down.setAttribute('aria-label', '不满意');
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
  /** @param {HTMLElement} root  @param {{ progress?: boolean }} [o] progress：工具调用合并成一张“工作进展”卡片（手机） */
  constructor(root, { progress = false } = {}) {
    this.root = root;
    this.interimEl = null;
    this.progress = progress;
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
    // 名字和时间分开放，方便桌面版把名字做成标题、时间淡一些（文字内容不变）
    head.append(Object.assign(document.createElement('span'), { className: 'who-name', textContent: LABEL[role] ?? role }), Object.assign(document.createElement('span'), { className: 'who-time', textContent: ` · ${hhmm(ts)}` }));
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
    let files = null; // 生成的文件按钮
    const self = this;
    // —— 连续的工具步骤收进一个分组（电脑）：执行中只占几行高、自动滚到最新一步；结束后折叠成“执行了 N 步”
    let group = null;
    function toolGroup() {
      const box = document.createElement('details');
      box.className = 'tool-group working';
      box.open = true;
      const sum = document.createElement('summary');
      const title = Object.assign(document.createElement('span'), { className: 'tg-title', textContent: '执行步骤' });
      const count = Object.assign(document.createElement('span'), { className: 'tg-count' });
      const last = Object.assign(document.createElement('span'), { className: 'tg-last' });
      sum.append(title, count, last);
      const list = Object.assign(document.createElement('div'), { className: 'tg-list' });
      box.append(sum, list);
      el.append(box);
      return { box, list, count, last, n: 0 };
    }
    function closeGroups() {
      for (const g of el.querySelectorAll('.tool-group')) {
        g.classList.remove('working');
        const n = g.querySelectorAll('.tool-card').length;
        const fail = g.querySelectorAll('.tool-card.fail').length;
        g.querySelector('.tg-title').textContent = `执行了 ${n} 步${fail ? `（${fail} 步出错）` : ''}`;
        g.querySelector('.tg-count').textContent = '';
        g.querySelector('.tg-last').textContent = '';
        if (n > 2) g.open = false;
      }
    }
    // —— “工作进展”卡片（手机）：每次调用工具加一行；整条回答结束后折叠成一行摘要
    let prog = null;
    const t0 = Date.now();
    const fmt = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`);
    function progressPanel() {
      if (prog) return prog;
      const box = document.createElement('details');
      box.className = 'progress-card working';
      box.open = true;
      const sum = document.createElement('summary');
      const title = Object.assign(document.createElement('strong'), { textContent: '工作进展' });
      const count = Object.assign(document.createElement('span'), { className: 'pc-count' });
      const time = Object.assign(document.createElement('span'), { className: 'pc-time' });
      sum.append(title, count, time);
      const bar = Object.assign(document.createElement('div'), { className: 'pc-bar' });
      const list = Object.assign(document.createElement('ol'), { className: 'pc-steps' });
      box.append(sum, bar, list);
      el.insertBefore(box, el.querySelector('.body'));
      const timer = setInterval(() => { time.textContent = fmt(Date.now() - t0); }, 1000);
      prog = { box, list, count, time, timer, n: 0, done: 0 };
      return prog;
    }
    function progressStep(name, args) {
      const p = progressPanel();
      p.n++;
      p.count.textContent = `第 ${p.n} 步`;
      const li = document.createElement('li');
      li.dataset.st = 'now';
      const d = document.createElement('details');
      const sm = document.createElement('summary');
      const ic = Object.assign(document.createElement('span'), { className: 'pc-ic' });
      const tx = document.createElement('span');
      tx.className = 'pc-tx';
      tx.append(Object.assign(document.createElement('b'), { textContent: toolLabel(name) }), Object.assign(document.createElement('small'), { textContent: summarizeArgs(name, args) }));
      const tm = Object.assign(document.createElement('span'), { className: 'pc-tm' });
      sm.append(ic, tx, tm);
      const pre = document.createElement('pre');
      d.append(sm, pre);
      li.append(d);
      p.list.append(li);
      const t1 = Date.now();
      self.#scroll();
      let log = '';
      return {
        progress(text) {
          log += `${log ? '\n' : ''}· ${text}`;
          pre.textContent = log;
          tx.querySelector('small').textContent = text.slice(0, 40);
        },
        done(ok, output, ms) {
          li.dataset.st = ok ? 'ok' : 'fail';
          tm.textContent = fmt(ms ?? Date.now() - t1);
          pre.textContent = log ? `${log}\n\n${output}` : output;
          p.done++;
          self.#scroll();
        }
      };
    }
    function finishProgress() {
      if (!prog) return;
      clearInterval(prog.timer);
      prog.box.classList.remove('working');
      for (const li of prog.list.querySelectorAll('li[data-st="now"]')) li.dataset.st = 'stop';
      prog.count.textContent = `用了 ${prog.n} 步`;
      prog.time.textContent = fmt(Date.now() - t0);
      prog.box.open = false;
    }
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
        if (self.progress) return progressStep(name, args);
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
        // 中间没有说话的连续工具调用放进同一个分组；有文字隔开就开新分组
        if (!group || curRaw.trim()) {
          group = toolGroup();
          const next = document.createElement('div');
          next.className = 'body';
          el.append(next);
          cur = next;
          curRaw = '';
        }
        const g = group;
        g.list.append(card);
        g.n++;
        g.count.textContent = `第 ${g.n} 步`;
        g.last.textContent = `${toolLabel(name)} ${summarizeArgs(name, args)}`;
        g.list.scrollTop = g.list.scrollHeight;
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
       * 团队分工卡片：每一步一行（角色 · 做什么 · 状态），点开看这一步的成果；底部是审核结论。
       * @param {Array<{ roleName: string, title: string }>} steps
       */
      teamCard(steps) {
        if (role === 'agent' && curRaw) renderBlocks(cur, curRaw);
        const card = document.createElement('div');
        card.className = 'team-card';
        const head = document.createElement('div');
        head.className = 'team-head';
        head.textContent = `团队分工 · ${steps.length} 步`;
        const list = document.createElement('ol');
        const ST = { pending: '等待', running: '进行中', done: '完成', fail: '失败', redo: '返工中' };
        const rows = steps.map((s) => {
          const li = document.createElement('li');
          li.dataset.st = 'pending';
          const d = document.createElement('details');
          const sum = document.createElement('summary');
          const r = Object.assign(document.createElement('span'), { className: 'team-role', textContent: s.roleName });
          const t = Object.assign(document.createElement('span'), { className: 'team-title', textContent: s.title });
          const st = Object.assign(document.createElement('span'), { className: 'team-st', textContent: ST.pending });
          sum.append(r, t, st);
          const pre = document.createElement('pre');
          d.append(sum, pre);
          li.append(d);
          list.append(li);
          return { li, st, pre };
        });
        const rev = document.createElement('div');
        rev.className = 'team-review';
        rev.hidden = true;
        card.append(head, list, rev);
        el.insertBefore(card, cur);
        self.#scroll();
        return {
          step(i, status, note) {
            const row = rows[i];
            if (!row) return;
            row.li.dataset.st = status;
            row.st.textContent = ST[status] ?? status;
            if (note) row.pre.textContent = status === 'redo' ? `审核意见：${note}\n\n${row.pre.textContent}` : note;
            self.#scroll();
          },
          review({ pass, issues = [], skipped }) {
            rev.hidden = false;
            rev.dataset.pass = pass ? '1' : '0';
            rev.textContent = skipped ? '审核员：演示模式下跳过审核' : pass ? '审核员：通过 ✓' : `审核员：发现 ${issues.length} 个问题，已交回返工 —— ${issues.join('；')}`;
            self.#scroll();
          }
        };
      },
      /**
       * 征求同意：在气泡里显示确认卡片。
       * @returns {Promise<'once'|'session'|'deny'>}
       */
      confirm({ title, detail, danger = false }) {
        const box = document.createElement('div');
        box.className = `confirm-card${danger ? ' danger' : ''}`;
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
          // 危险命令不提供“本次都允许”：每次都要单独确认
          const choices = [['once', '允许', 'btn sm', '已允许'], ...(danger ? [] : [['session', '本次都允许', 'btn ghost sm', '已允许（本次会话不再询问）']]), ['deny', '拒绝', 'btn ghost sm danger', '已拒绝']];
          for (const [v, label, cls, result] of choices) {
            const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label });
            b.addEventListener('click', () => done(v, result));
            row.append(b);
          }
          row.querySelector('button').focus({ preventScroll: true });
          box.cancel = () => done('deny', '已取消');
        });
      },
      /** 这一轮生成 / 修改的文件：回答末尾一排按钮，点一下在工作区里打开 */
      fileLink(path, onOpen) {
        if (!files) { files = document.createElement('div'); files.className = 'file-links'; el.append(files); }
        if ([...files.children].some((b) => b.dataset.path === path)) return;
        const name = path.split('/').pop();
        const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'file-link', title: `在工作区打开 ${path}` });
        b.dataset.path = path;
        b.append(Object.assign(document.createElement('span'), { className: 'fl-ext', textContent: ext.slice(0, 4) || '文件' }), Object.assign(document.createElement('span'), { className: 'fl-name', textContent: name }), Object.assign(document.createElement('span'), { className: 'fl-go', textContent: '打开 ›' }));
        b.addEventListener('click', () => onOpen(path));
        files.append(b);
        self.#scroll();
      },
      /** 生成的图片：显示在当前文字段之前 */
      image(src, alt = '生成的图片') {
        const img = Object.assign(document.createElement('img'), { src, alt, className: 'gen-image', loading: 'lazy' });
        el.insertBefore(img, cur);
        self.#scroll();
      },
      video(src) {
        const v = Object.assign(document.createElement('video'), { src, controls: true, playsInline: true, preload: 'metadata', className: 'gen-image gen-video' });
        el.insertBefore(v, cur);
        self.#scroll();
      },
      sources(names) {
        const box = document.createElement('div');
        box.className = 'sources';
        box.append('参考：', ...[...new Set(names)].map((n) => Object.assign(document.createElement('span'), { textContent: n })));
        el.insertBefore(box, el.children[1]);
      },
      done(meta, { onFeedback } = {}) {
        el.classList.remove('streaming');
        finishProgress();
        closeGroups();
        if (role === 'agent' && curRaw) renderBlocks(cur, curRaw);
        for (const b of el.querySelectorAll('.body')) if (!b.textContent.trim() && !b.children.length) b.remove();
        if (files) el.append(files); // 文件按钮放在回答最后
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
