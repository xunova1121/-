/**
 * 对话记录 DOM。流式阶段用 textContent 追加纯文本；回复完成后按极简 Markdown 重排，
 * 全程只用 createElement + textContent，从不把模型输出当 HTML 插入。
 */
import { imageButton, previewWorkspaceImage, showImagePreview } from './imagePreview.js';
import './mobileImprovements.css';
import { parseMarkdown, inline, toPlainText } from '../core/markdown.js';
import { stripEmotionTags } from '../../shared/emotionTag.js';
import { createMascot, setMascotState, poseForEmotion, poseForTask } from './mascot.js';

const LABEL = { user: '你', agent: '未央' };

const nextFrame = (f) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 16));
const cancelFrame = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

export function renderBlocks(container, text) {
  text = stripEmotionTags(text); // 旧对话里可能存着写错的情绪标签
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
          cell.append(...inline(c).map(span));
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
  if (s.link) return linkEl(s.text, s.link);
  if (!s.bold && !s.code) return document.createTextNode(s.text);
  const el = document.createElement(s.code ? 'code' : 'strong');
  el.textContent = s.text;
  return el;
}

/**
 * 链接：来源网址（文字就是域名或网址）显示成“首字母圆点 + 域名”的小标签；
 * 其它文字链接加下划线和 ↗。点一下用系统浏览器打开（电脑用默认浏览器，手机交给系统）
 */
export function linkEl(text, href) {
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { return document.createTextNode(text); }
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = href;
  const t = text.trim();
  if (/^https?:\/\//i.test(t) || (!/[\u4e00-\u9fff]/.test(t) && /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t))) {
    a.className = 'src-chip';
    const dot = document.createElement('i');
    // 主域名的首字母：top.baidu.com → B，news.cn → N，xinhua.com.cn → X
    const parts = host.split('.');
    const main = parts.length > 2 && /^(com|net|org|gov|edu|co)$/.test(parts.at(-2)) ? parts.at(-3) : parts.at(-2) || host;
    dot.textContent = main[0]?.toUpperCase() || '·';
    let h = 0;
    for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) % 360;
    dot.style.setProperty('--h', h);
    const name = document.createElement('span');
    name.textContent = host;
    a.append(dot, name);
  } else {
    a.className = 'md-link';
    a.textContent = t;
  }
  return a;
}

// 模型自带联网搜索时，步骤卡上写的是哪家模型在搜
export function searchBrand(model = '') {
  const m = String(model).toLowerCase();
  if (/claude/.test(m)) return 'Claude ';
  if (/gpt|(^|[:/])o\d|codex/.test(m)) return 'GPT ';
  if (/gemini/.test(m)) return 'Gemini ';
  return '模型';
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
  update_plan: '更新清单', delegate_task: '交给分身', find_files: '找文件', search_in_files: '搜内容',
  web_search: '联网搜索', deep_research: '深度调研', get_current_time: '读取时间', get_weather: '查天气', get_local_metrics: '读取系统状态',
  generate_image: '画图', generate_video: '生成视频', copy_skill_file: '复制技能文件', show_image: '显示图片',
  use_skill: '使用技能', read_skill_file: '读取技能文件', schedule_task: '创建定时任务', list_schedules: '查看定时任务', cancel_schedule: '删除定时任务', core_memory_update: '更新核心记忆',
  computer_list_dir: '查看文件夹', computer_read_file: '读取电脑文件', computer_write_file: '写入电脑文件', computer_save_from_workspace: '保存到电脑',
  computer_move: '移动 / 重命名', computer_copy: '复制文件', computer_trash: '移到回收站', computer_search: '搜索文件', computer_open: '打开',
  computer_run: '运行命令', computer_screenshot: '截屏', computer_look: '看屏幕', computer_click: '点击', computer_type: '键盘输入', computer_key: '按键', computer_scroll: '滚动', computer_drag: '拖动', clipboard_read: '读剪贴板', clipboard_write: '写剪贴板', computer_notify: '系统通知'
};

export function summarizeArgs(name, a = {}) {
  if (a.place) return `${a.place}${a.days ? ` · ${a.days} 天` : ''}`;
  if (a.task) return String(a.task).slice(0, 60);
  if (a.pattern) return a.pattern;
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

/** 复制到剪贴板：先用系统剪贴板接口，不行（手机 App 里偶尔没有权限）就用隐藏输入框复制 */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 退回旧办法 */ }
  try {
    const t = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    t.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}

/** 消息下面小按钮的图标（Lucide，ISC 许可，https://lucide.dev） */
const ICONS = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  speak: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>',
  stop: '<rect width="12" height="12" x="6" y="6" rx="2"/>',
  edit: '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/>',
  retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'
};
/** 换按钮的图标（朗读中换成“停止”、复制后换成勾） */
export function setActionIcon(btn, name) {
  btn.querySelector('svg').innerHTML = ICONS[name] ?? '';
}

/** 每条消息下面的小图标按钮：复制 / 引用（放进输入框接着问）/ 编辑重发（你的）/ 朗读、重新生成（未央的） */
function messageActions(role, getText, onAction) {
  const box = document.createElement('span');
  box.className = 'msg-actions';
  const btn = (kind, title) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `msg-act msg-${kind}`, title });
    b.setAttribute('aria-label', title);
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
    b.addEventListener('click', async () => {
      const text = getText();
      if (!text.trim()) return;
      if (kind === 'copy') {
        const ok = await copyText(toPlainText(text));
        setActionIcon(b, ok ? 'check' : 'copy');
        b.title = ok ? '已复制' : '复制失败';
        setTimeout(() => { setActionIcon(b, 'copy'); b.title = '复制'; }, 1500);
        return;
      }
      onAction?.(kind, text, b);
    });
    return b;
  };
  box.append(btn('copy', '复制'), btn('quote', '引用，接着问'));
  if (role === 'user') box.append(btn('edit', '编辑后重新发送'));
  else box.append(btn('speak', '朗读'), btn('retry', '重新生成这条回答'));
  return box;
}

/** 很长的回答先只显示开头（翻看旧消息时用）：少画很多内容，手机上更稳、更省电；点“展开全文”再画全部 */
export const FOLD_CHARS = 900;
export function foldPreview(text, max = FOLD_CHARS) {
  if (text.length <= max * 1.4) return null;
  // 在段落处切开；切在代码块中间时补上结尾，免得后面全变成代码
  let cut = text.lastIndexOf('\n\n', max);
  if (cut < max * 0.4) cut = max;
  let head = text.slice(0, cut).trimEnd();
  if ((head.match(/^```/gm) || []).length % 2) head += '\n```';
  return head;
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export class Transcript {
  /** @param {HTMLElement} root  @param {{ progress?: boolean }} [o] progress：工具调用合并成一张“工作进展”卡片（手机） */
  constructor(root, { progress = false } = {}) {
    this.root = root;
    this.interimEl = null;
    this.progress = progress;
    this.follow = true;
    root.addEventListener('scroll', () => {
      this.follow = root.scrollHeight - root.scrollTop - root.clientHeight < 140;
      document.body.classList.toggle('wy-reading-history', !this.follow);
    }, { passive:true });
    // 区域变矮（手机弹出键盘、输入框变高）时保持底部对齐：已输出的内容往上推，而不是被输入框盖住
    if (typeof ResizeObserver === 'function') {
      let lastH = root.clientHeight;
      new ResizeObserver(() => {
        const h = root.clientHeight;
        if (h < lastH && this.follow && !root.querySelector('.welcome')) root.scrollTop += lastH - h;
        lastH = h;
      }).observe(root);
    }
  }

  /**
   * @param {'user'|'agent'} role
   * @returns 气泡控制对象：append / done / toolCard / sources / feedback
   */
  add(role, text = '', ts = Date.now(), { thumbs = [] } = {}) {
    this.clearInterim();
    if (role === 'user') { this.follow = true; document.body.classList.remove('wy-reading-history'); }
    this.root.querySelector('.welcome')?.remove();
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const head = document.createElement('span');
    head.className = 'who';
    // 名字和时间分开放，方便桌面版把名字做成标题、时间淡一些（文字内容不变）
    head.append(Object.assign(document.createElement('span'), { className: 'who-name', textContent: LABEL[role] ?? role }), Object.assign(document.createElement('span'), { className: 'who-time', textContent: ` · ${hhmm(ts)}` }));
    const mascot = role === 'agent' ? createMascot(text ? 'idle' : 'think') : null;
    if (mascot) { mascot.classList.add('who-mood'); head.prepend(mascot); }
    // 小精灵旁的气泡只在回答过程中显示状态（想 / 查资料 / 搓手）；答完就收起，不在每条回答前留一句固定的话
    const greeting = role === 'agent' && !text ? Object.assign(document.createElement('span'), { className:'wy-reply-greeting', textContent:'我在想，稍等一下哦…' }) : null;
    if (greeting) head.append(greeting);
    // 在做什么：回答末尾（电脑）和小精灵旁边（手机）都显示
    const setStatus = (words) => { el.dataset.status = words; head.dataset.status = words; if (greeting && el.classList.contains('streaming')) greeting.textContent = words; };
    const present = (state, detail = '') => {
      if (!mascot) return;
      setMascotState(mascot, state);
      const words = detail || ({think:'我在想，稍等一下哦…',rub:'搓搓手，交给我吧。',run:'正在帮你找资料…',happy:'整理好啦，一起看看。',listen:'我在听，慢慢说。',wink:'我在呀，慢慢来。',sleep:'休息一下，有事叫我。',love:'送你一颗小小的心。'}[state] || '我在这里，陪着你。');
      if (greeting) greeting.textContent = words;
      if (el.classList.contains('streaming') || !text) setStatus(words);
    };
    if (role === 'agent' && !text) setStatus('我在想，稍等一下哦…');
    const sizeReply = value => el.classList.toggle('wy-long-reply', value.length > 480 || value.split('\n').length > 10);
    if (role === 'agent') sizeReply(text);
    let moodState = null;
    const body = document.createElement('div');
    body.className = 'body';
    const upload = role === 'user' ? text.match(/\n*\[已上传到工作区：([^\]]+)\]$/) : null;
    body.textContent = upload ? text.slice(0,upload.index).trim() : text;
    el.append(head, body);
    if (thumbs?.length) {
      const row = document.createElement('div');
      row.className = 'msg-images';
      for (const item of thumbs) { const src = typeof item === 'string' ? item : item.src; row.append(imageButton(src, () => item.path ? previewWorkspaceImage(item.path, src) : showImagePreview(src, { title:'上传图片预览' }))); }
      el.insertBefore(row, body);
    }
    if (upload) {
      const receipt = Object.assign(document.createElement('button'), { type:'button', className:'upload-receipt', textContent:'已上传工作区' });
      receipt.onclick = () => globalThis.dispatchEvent(new CustomEvent('jarvis:open-upload', { detail: { path: upload[1].split('、')[0] } })); el.append(receipt);
    }
    if (role === 'user' && text) {
      const said = upload ? text.slice(0, upload.index).trim() : text;
      const m = Object.assign(document.createElement('div'), { className: 'meta' });
      m.append(messageActions('user', () => said, (...a) => this.onAction?.(...a)));
      el.append(m);
    }
    this.root.append(el);
    this.#scroll();
    let raw = text;
    // 文字与工具卡片按时间顺序交替出现：每段文字一个独立的 body
    let cur = body;
    let curRaw = text;
    let frame = 0;
    let tail = null; // 正在输出的那段文字的文本节点
    const paint = () => {
      frame = 0;
      const s = stripEmotionTags(curRaw);
      if (role === 'agent') sizeReply(raw);
      if (tail && tail.parentNode === cur && s.startsWith(tail.data)) tail.appendData(s.slice(tail.data.length));
      else { cur.textContent = s; tail = cur.firstChild; }
      self.#scroll();
    };
    const stopPaint = () => { if (frame) { cancelFrame(frame); paint(); } tail = null; }; // 还没刷出来的字先刷上，再交给排版
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
      box.open = false;
      const sum = document.createElement('summary');
      const title = Object.assign(document.createElement('strong'), { textContent: '工作进展' });
      const count = Object.assign(document.createElement('span'), { className: 'pc-count' });
      const time = Object.assign(document.createElement('span'), { className: 'pc-time' });
      const action = createMascot('rub'); action.classList.add('pc-mascot');
      sum.append(action, title, count, time);
      const bar = Object.assign(document.createElement('div'), { className: 'pc-bar' });
      const list = Object.assign(document.createElement('ol'), { className: 'pc-steps' });
      box.append(sum, bar, list);
      el.insertBefore(box, el.querySelector('.body'));
      const timer = setInterval(() => { time.textContent = fmt(Date.now() - t0); }, 1000);
      prog = { box, list, count, time, timer, action, n: 0, done: 0 };
      return prog;
    }
    function progressStep(name, args) {
      const p = progressPanel();
      p.n++;
      setMascotState(p.action, poseForTask('processing',toolLabel(name)));
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
      p.list.scrollTop = p.list.scrollHeight; // 执行中卡片高度固定，步骤在里面滚动，停在最新一步
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
          p.list.scrollTop = p.list.scrollHeight;
          self.#scroll();
        }
      };
    }
    function finishProgress() {
      if (!prog) return;
      clearInterval(prog.timer);
      prog.box.classList.remove('working');
      setMascotState(prog.action, prog.list.querySelector('li[data-st=fail]') ? 'think' : 'happy');
      for (const li of prog.list.querySelectorAll('li[data-st="now"]')) li.dataset.st = 'stop';
      prog.count.textContent = `用了 ${prog.n} 步 · 点开查看`;
      prog.time.textContent = fmt(Date.now() - t0);
      prog.box.open = false;
    }
    let planBox = null;
    return {
      el,
      get text() { return raw; },
      /** 任务清单：放在回答最前面，每次更新整份重画（○ 未开始 / ◐ 进行中 / ✓ 已完成 / – 不做了） */
      plan(steps = []) {
        if (!planBox) {
          planBox = document.createElement('div');
          planBox.className = 'plan-card';
          el.insertBefore(planBox, el.children[1] ?? null);
        }
        const done = steps.filter((s) => s.status === 'done').length;
        const title = Object.assign(document.createElement('div'), { className: 'plan-head', textContent: `任务清单 · ${done}/${steps.length}` });
        const list = document.createElement('ol');
        for (const s of steps) {
          const li = document.createElement('li');
          li.append(Object.assign(document.createElement('span'), { textContent: s.text }));
          li.dataset.st = s.status;
          list.append(li);
        }
        planBox.replaceChildren(title, list);
        self.#scroll();
      },
      /** 表情：在“未央 · 时间”旁边放一个小图标（不显示英文标签） */
      /** 回答末尾转圈旁的状态字（正在查资料、正在生成 PPT…） */
      status(text) { setStatus(text); if (greeting) greeting.textContent = text; },
      mood(v) {
        if (!mascot) return;
        moodState = poseForEmotion(v);
        present(moodState);
      },
      activity(state, detail = '') { present(poseForTask(state, detail), state==='error' ? '这次没有完成，我们再试一次。' : ''); },
      append(d) {
        if (el.dataset.status !== '正在写回答…') setStatus('正在写回答…');
        raw += d;
        curRaw += d;
        // 每一帧最多刷新一次，只把新增的字接在后面：逐字重排整段回答在手机上很慢，回答越长越卡
        frame ||= nextFrame(paint);
      },
      /** 工具执行卡片：执行中显示动画，结束后可展开查看输出 */
      toolCard(name, args) {
        present(poseForTask('processing',toolLabel(name)));
        stopPaint();
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
        stopPaint();
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
      /** 唱好的歌：对话里直接播放 */
      audio(src) {
        const a = Object.assign(document.createElement('audio'), { src, controls: true, preload: 'metadata', className: 'gen-audio' });
        el.insertBefore(a, cur);
        self.#scroll();
      },
      sources(names) {
        const box = document.createElement('div');
        box.className = 'sources';
        box.append('参考：', ...[...new Set(names)].map((n) => Object.assign(document.createElement('span'), { textContent: n })));
        el.insertBefore(box, el.children[1]);
      },
      done(meta, { onFeedback, fold = false } = {}) {
        if (mascot) {
          const paused = /已打断|中断/.test(meta || '');
          present(paused ? 'think' : moodState || 'happy');
          greeting?.remove();
          sizeReply(raw);
        }
        el.classList.remove('streaming');
        finishProgress();
        closeGroups();
        stopPaint();
        const preview = role === 'agent' && curRaw && fold ? foldPreview(stripEmotionTags(curRaw)) : null;
        if (preview) {
          renderBlocks(cur, preview);
          const full = curRaw, target = cur;
          const more = Object.assign(document.createElement('button'), { type: 'button', className: 'msg-unfold', textContent: `展开全文（共 ${stripEmotionTags(full).length} 字）` });
          more.addEventListener('click', () => { renderBlocks(target, full); more.remove(); });
          cur.after(more);
        } else if (role === 'agent' && curRaw) renderBlocks(cur, curRaw);
        for (const b of el.querySelectorAll('.body')) if (!b.textContent.trim() && !b.children.length) b.remove();
        if (files) el.append(files); // 文件按钮放在回答最后
        const m = document.createElement('div');
        m.className = 'meta';
        if (meta) m.append(meta);
        const said = stripEmotionTags(raw);
        if (role === 'agent' && said.trim()) m.append(messageActions('agent', () => said, (...a) => self.onAction?.(...a)));
        if (onFeedback) m.append(feedbackButtons(m, onFeedback));
        if (m.childNodes.length) el.append(m);
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

  /** 重放历史时只在末尾读取一次布局，避免每条消息都强制重排。 */
  batch(render) {
    this.batching = true;
    try { return render(); } finally { this.batching = false; this.#scroll(); }
  }

  #scroll() {
    if (!this.batching && this.follow) this.root.scrollTop = this.root.scrollHeight;
  }
}

