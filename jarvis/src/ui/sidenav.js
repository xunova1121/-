/**
 * 电脑版左侧导航栏（取代原来的图标竖栏）：
 *   标题 + 收起 / 搜索 → 新建对话 → 功能列表（打开右侧面板）→ 对话历史（今天 / 昨天 / 更早）→ 底部：等级、主题
 * 收起后只剩一列图标。
 */
import { groupSessions } from './drawer.js';

const ICON = {
  new: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  skills: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1 1.3 2.1 2 3.5 2s2.5-.7 3.5-2M9 10h.01M15 10h.01"/></svg>',
  system: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>',
  workspace: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 13h8"/></svg>',
  knowledge: '<svg viewBox="0 0 24 24"><path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z"/></svg>',
  mind: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.9V16h5v-.2c0-.8.4-1.5 1-1.9A6 6 0 0 0 12 3z"/></svg>',
  models: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  collapse: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4"/></svg>'
};
const FEATURES = [
  ['skills', '技能广场'], ['system', '定时任务'], ['workspace', '文件空间'], ['knowledge', '知识库'],
  ['mind', '记忆空间'], ['models', '模型与声音'], ['settings', '设置']
];
const FOLDED = 4; // 收起时只显示前几项

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
const iconBtn = (name, title) => {
  const b = el('button', { type: 'button', className: 'sn-icon', title, ariaLabel: title });
  b.innerHTML = ICON[name];
  return b;
};

/**
 * @param {{ onNew, onOpenSession: (id) => void, onPanel: (name) => void, onSearch: () => void, listSessions: () => Promise<object[]>, currentId: () => string, settings: object, setSetting: Function, footer?: HTMLElement[] }} o
 */
export function initSidenav({ onNew, onOpenSession, onPanel, onSearch, listSessions, currentId, settings, setSetting, footer = [] }) {
  const nav = el('aside', { className: 'sidenav', ariaLabel: '导航' });
  const collapseBtn = iconBtn('collapse', '收起侧栏');
  const searchBtn = iconBtn('search', '搜索命令和对话（Ctrl+K）');
  collapseBtn.addEventListener('click', () => setCollapsed(!document.body.classList.contains('nav-collapsed')));
  searchBtn.addEventListener('click', () => onSearch());
  const head = el('div', { className: 'sn-head' },
    el('div', { className: 'sn-brand' }, el('span', { className: 'brand-mark', ariaHidden: 'true' }), el('span', { className: 'sn-name', textContent: '贾维斯' })),
    el('div', { className: 'sn-tools' }, collapseBtn, searchBtn));

  const item = (id, label, icon = ICON[id]) => {
    const b = el('button', { type: 'button', className: 'sn-item', title: label });
    b.dataset.panel = id;
    b.innerHTML = icon;
    b.append(el('span', { textContent: label }));
    return b;
  };
  const newBtn = item('', '新建对话', ICON.new);
  newBtn.classList.add('sn-new');
  delete newBtn.dataset.panel;
  newBtn.addEventListener('click', () => onNew());
  const feats = FEATURES.map(([id, label]) => {
    const b = item(id, label);
    b.addEventListener('click', () => onPanel(id));
    return b;
  });
  const moreBtn = el('button', { type: 'button', className: 'sn-item sn-more' });
  moreBtn.addEventListener('click', () => { setSetting('navExpanded', !settings.navExpanded); renderFold(); });
  function renderFold() {
    const open = settings.navExpanded;
    feats.forEach((b, i) => { b.hidden = !open && i >= FOLDED; });
    moreBtn.innerHTML = ICON.more;
    moreBtn.classList.toggle('open', open);
    moreBtn.append(el('span', { textContent: open ? '收起' : '更多' }));
  }
  renderFold();

  const histHead = el('div', { className: 'sn-section' }, el('span', { textContent: '对话' }));
  const allBtn = iconBtn('sort', '全部对话');
  allBtn.addEventListener('click', () => onPanel('sessions'));
  histHead.append(allBtn);
  const history = el('div', { className: 'sn-history' });

  nav.append(head, el('div', { className: 'sn-scroll' }, el('div', { className: 'sn-list' }, newBtn, ...feats, moreBtn), histHead, history), el('div', { className: 'sn-foot' }, ...footer));
  document.querySelector('.app')?.prepend(nav);

  async function refresh() {
    const list = await listSessions().catch(() => []);
    const cur = currentId();
    if (!list.length) { history.replaceChildren(el('p', { className: 'sn-empty', textContent: '还没有对话' })); return; }
    const shown = list.slice(0, 12);
    history.replaceChildren(...groupSessions(shown).flatMap(([name, items]) => [
      el('div', { className: 'sn-group', textContent: name }),
      ...items.map((s) => {
        const b = el('button', { type: 'button', className: `sn-session${s.id === cur ? ' current' : ''}`, textContent: s.title || '新对话', title: s.title || '新对话' });
        b.addEventListener('click', () => onOpenSession(s.id));
        return b;
      })
    ]), ...(list.length > shown.length ? [(() => {
      const m = el('button', { type: 'button', className: 'sn-all', textContent: `查看更多（${list.length - shown.length}）` });
      m.addEventListener('click', () => onPanel('sessions'));
      return m;
    })()] : []));
  }
  function setCollapsed(on) {
    document.body.classList.toggle('nav-collapsed', on);
    collapseBtn.title = on ? '展开侧栏' : '收起侧栏';
    setSetting('navCollapsed', on);
  }
  /** 当前打开的面板高亮 */
  function setActive(name) {
    for (const b of feats) b.classList.toggle('active', b.dataset.panel === name);
  }
  if (settings.navCollapsed) setCollapsed(true);
  refresh();
  return { refresh, setActive, el: nav };
}
