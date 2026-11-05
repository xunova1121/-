import './agentSquare.css';
/**
 * 智能体广场（设计稿 P2）与智能体起始页（P3）的界面：只负责画和收点击，数据和动作由 src/app/agents.js 传进来。
 *   - 广场：搜索、分类横滑、两列（电脑四列）卡片、加载骨架、搜不到的空状态；关掉再打开保留搜索和分类
 *   - 起始页：图标、名字、开场白、表单下拉、3 条推荐问题（点了只填输入框）、上传资料入口
 */
import { agentIcon, AGENT_TONES } from './agentIcons.js';
import { templatePicker } from './pptTemplateLibrary.js';

export const CATEGORY_LABELS = { '': '全部', office: '办公创作', gongwen: '公文写作', image: '图片处理', research: '查询研究', life: '生活服务', mine: '我的' };
const SOURCE_LABELS = { builtin: '内置', user: '我创建的', github: '来自 GitHub' };

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
/** 图标：SVG 是本仓库里的固定字符串，不来自用户输入 */
export function iconBadge(profile, size = 'md') {
  const b = el('span', { className: `wy-agent-icon ${size}` });
  b.dataset.tone = AGENT_TONES[profile?.icon] || 'accent';
  b.innerHTML = agentIcon(profile?.icon);
  return b;
}

/**
 * @param {{ listAgents: (o?: object) => Promise<object[]>, onPick: (profile: object) => void, onClose?: () => void }} o
 */
export function createAgentSquare({ listAgents, onPick, onClose = () => {} }) {
  const state = { query: '', category: '' };
  const back = el('button', { type: 'button', className: 'wy-agents-back', ariaLabel: '返回' });
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  const search = el('input', { type: 'search', className: 'wy-agents-search-input', placeholder: '搜索智能体或想做的事', enterKeyHint: 'search', maxLength: 100 });
  search.setAttribute('aria-label', '搜索智能体');
  const chips = el('div', { className: 'wy-agents-chips', role: 'tablist' }, ...Object.entries(CATEGORY_LABELS).map(([id, label]) => {
    const c = el('button', { type: 'button', className: 'wy-agents-chip', textContent: label, role: 'tab' });
    c.dataset.category = id;
    c.addEventListener('click', () => { state.category = id; render(); });
    return c;
  }));
  const banner = el('button', { type: 'button', className: 'wy-agents-banner' },
    el('span', { className: 'wy-agents-banner-copy' },
      el('small', { textContent: '从资料到表达' }),
      el('b', { textContent: '下一份汇报，一起做好' }),
      el('span', { textContent: '选模板，放资料，让每一页更清楚。' })),
    el('span', { className: 'wy-agents-banner-art', ariaHidden: 'true' }, el('i'), el('i'), el('i')));
  const grid = el('div', { className: 'wy-agents-grid', ariaLive: 'polite' });
  const root = el('section', { className: 'wy-agents', hidden: true, ariaLabel: '发现智能体' },
    el('header', { className: 'wy-agents-bar' }, back, el('h2', { textContent: '发现智能体' })),
    el('div', { className: 'wy-agents-body' },
      el('label', { className: 'wy-agents-search' }, el('span', { className: 'wy-agents-search-icon', ariaHidden: 'true' }), search),
      banner, chips, grid));
  root.setAttribute('role', 'dialog');
  document.body.append(root);

  let all = [];
  let seq = 0;
  let timer = 0;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.query = search.value.trim(); render(); }, 150); });
  back.addEventListener('click', close);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  banner.addEventListener('click', () => { const p = all.find((x) => x.id === 'ppt-maker'); if (p) pick(p); });

  function card(p) {
    const b = el('button', { type: 'button', className: 'wy-agent-card' },
      el('span', { className: 'wy-agent-card-top' }, iconBadge(p), el('span', { className: 'wy-agent-tag', textContent: SOURCE_LABELS[p.source] || '' })),
      el('b', { textContent: p.name }),
      el('span', { className: 'wy-agent-card-intro', textContent: p.intro }));
    b.dataset.agent = p.id;
    b.addEventListener('click', () => pick(p));
    return b;
  }
  function matches(p) {
    const q = state.query.toLocaleLowerCase();
    const inCat = !state.category || (state.category === 'mine' ? p.source !== 'builtin' : p.category === state.category);
    return inCat && (!q || `${p.name}\n${p.intro}\n${p.starters.join('\n')}`.toLocaleLowerCase().includes(q));
  }
  function render() {
    for (const c of chips.children) { const on = c.dataset.category === state.category; c.classList.toggle('on', on); c.setAttribute('aria-selected', String(on)); }
    banner.hidden = Boolean(state.query || state.category);
    const shown = all.filter(matches);
    if (shown.length) { grid.replaceChildren(...shown.map(card)); return; }
    const hint = state.category === 'mine' && !state.query ? '还没有自己创建的智能体' : `没有找到“${state.query || CATEGORY_LABELS[state.category]}”相关的智能体`;
    grid.replaceChildren(el('div', { className: 'wy-agents-empty' }, el('b', { textContent: hint }), el('span', { textContent: '换个说法试试，或者回到普通对话直接说你要做的事。' })));
  }
  async function load() {
    const mine = ++seq;
    if (!all.length) grid.replaceChildren(...Array.from({ length: 4 }, () => el('div', { className: 'wy-agent-card skeleton', ariaHidden: 'true' })));
    try {
      const list = await listAgents();
      if (mine !== seq) return;
      all = list;
      render();
    } catch (e) {
      if (mine !== seq) return;
      grid.replaceChildren(el('div', { className: 'wy-agents-empty' }, el('b', { textContent: '读不到智能体列表' }), el('span', { textContent: String(e?.message || '网络不好？稍后再打开试试') })));
    }
  }
  function pick(p) { close(); onPick(p); }
  function open() {
    search.value = state.query;
    root.hidden = false;
    document.body.classList.add('wy-agents-open');
    load();
    requestAnimationFrame(() => back.focus());
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('wy-agents-open');
    onClose();
  }
  return { root, open, close, get isOpen() { return !root.hidden; }, state };
}

/**
 * 智能体起始页（空对话时显示在对话区）
 * @param {object} profile
 * @param {{ values?: Record<string,string>, onFill: (text: string) => void, onForm: (values: Record<string,string>) => void, onUpload?: () => void, onBack?: () => void }} o
 */
export function agentStartView(profile, { values = {}, onFill, onForm, onUpload, onBack, onTemplates }) {
  const form = { ...values };
  // 模板字段画成卡片（P4“先选一个喜欢的样子”），其余选项画成下拉框
  const hasTemplate = (profile.form || []).some((f) => f.key === 'template');
  const picker = hasTemplate && templatePicker({ value: form.template || '', onMore: onTemplates, onChange: (id) => { if (id) form.template = id; else delete form.template; onForm({ ...form }); } });
  const fields = (profile.form || []).filter((f) => f.type === 'select' && f.key !== 'template').map((f) => {
    const select = el('select', { className: 'wy-agent-select' }, el('option', { value: '', textContent: '不限' }), ...f.options.map((o) => el('option', { value: o, textContent: o })));
    select.value = f.options.includes(form[f.key]) ? form[f.key] : '';
    select.setAttribute('aria-label', f.label);
    select.addEventListener('change', () => {
      if (select.value) form[f.key] = select.value; else delete form[f.key];
      onForm({ ...form });
    });
    return el('label', { className: 'wy-agent-field' }, el('span', { textContent: f.label }), select);
  });
  const starters = profile.starters.map((s) => {
    const b = el('button', { type: 'button', className: 'wy-agent-starter' }, el('span', { textContent: s }));
    b.addEventListener('click', () => onFill(s));
    return b;
  });
  const upload = onUpload && el('button', { type: 'button', className: 'wy-agent-upload' },
    el('span', { className: 'wy-agent-upload-copy' }, el('b', { textContent: '也可以上传资料' }), el('span', { textContent: '支持图片、PDF 和 Word' })),
    el('span', { className: 'wy-agent-upload-plus', ariaHidden: 'true', textContent: '+' }));
  upload?.addEventListener('click', onUpload);
  const backBtn = onBack && el('button', { type: 'button', className: 'wy-agent-back-link', textContent: '‹ 回到智能体广场' });
  backBtn?.addEventListener('click', onBack);
  const root = el('section', { className: 'wy-agent-start' },
    backBtn,
    el('header', { className: 'wy-agent-start-head' }, iconBadge(profile, 'lg'),
      el('span', {}, el('b', { textContent: profile.name }), el('small', { textContent: '未央 · 你的专属帮手' }))),
    el('p', { className: 'wy-agent-start-intro', textContent: profile.intro }),
    fields.length ? el('div', { className: 'wy-agent-form' }, ...fields) : null,
    picker ? picker.root : null,
    el('div', { className: 'wy-agent-start-label' }, el('b', { textContent: '从这里开始' }), el('small', { textContent: '点选后可修改' })),
    el('div', { className: 'wy-agent-starters' }, ...starters),
    upload,
    el('p', { className: 'wy-agent-start-note', textContent: '问题会先填入输入框，由你确认发送。' }));
  root.dataset.agent = profile.id;
  return root;
}
