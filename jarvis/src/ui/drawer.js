/**
 * 手机左侧抽屉（取代底部菜单栏）：标题 → 开启新对话 → 功能宫格（原底部菜单） → 历史对话（按今天 / 昨天 / 更早分组）。
 * 点左上角菜单按钮或从屏幕左边缘向右滑打开；点遮罩、向左滑或选了某一项后关闭。
 */
const FEATURES = [
  ['workspace', '工作区'], ['knowledge', '知识库'], ['mind', '记忆进化'], ['skills', '技能'],
  ['models', '模型'], ['system', '定时任务'], ['settings', '设置'], ['sessions', '全部对话']
];

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/** 纯函数：会话按日期分组（今天 / 昨天 / 近 7 天 / 更早） */
export function groupSessions(list, now = Date.now()) {
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = day(now);
  const groups = [['今天', []], ['昨天', []], ['近 7 天', []], ['更早', []]];
  for (const s of list) {
    const d = day(s.updatedAt ?? s.createdAt ?? now);
    const i = d >= today ? 0 : d >= today - 864e5 ? 1 : d >= today - 7 * 864e5 ? 2 : 3;
    groups[i][1].push(s);
  }
  return groups.filter(([, items]) => items.length);
}

/**
 * @param {{ onNew: () => void, onOpenSession: (id: string) => void, onPanel: (name: string) => void, listSessions: () => Promise<object[]>, currentId: () => string, icons: Record<string, string> }} o
 */
export function initDrawer({ onNew, onOpenSession, onPanel, listSessions, currentId, icons = {} }) {
  const scrim = el('div', { className: 'drawer-scrim', hidden: true });
  const history = el('div', { className: 'drawer-history' });
  const grid = el('div', { className: 'drawer-grid' }, ...FEATURES.map(([id, label]) => {
    const b = el('button', { type: 'button', className: 'drawer-feat' });
    b.innerHTML = icons[id] || '';
    b.append(el('span', { textContent: label }));
    b.addEventListener('click', () => { close(); onPanel(id); });
    return b;
  }));
  const newBtn = el('button', { type: 'button', className: 'drawer-new' });
  newBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h11M4 5v11h4v4l4-4h8V11"/><path d="M19 3v6M16 6h6"/></svg>';
  newBtn.append('开启新对话');
  newBtn.addEventListener('click', () => { close(); onNew(); });
  const drawer = el('aside', { className: 'drawer', id: 'drawer', ariaLabel: '菜单' },
    el('div', { className: 'drawer-head' }, el('div', { className: 'drawer-title' }, el('strong', { textContent: '未央' }), el('small', { textContent: '个人智能助手' }))),
    newBtn,
    el('section', { className: 'drawer-card' }, el('h3', { textContent: '功能' }), grid),
    el('section', { className: 'drawer-card drawer-hist' }, el('h3', { textContent: '历史对话' }), history)
  );
  drawer.setAttribute('aria-hidden', 'true');
  document.body.append(scrim, drawer);

  async function refresh() {
    const list = await listSessions().catch(() => []);
    const cur = currentId();
    if (!list.length) { history.replaceChildren(el('p', { className: 'drawer-empty', textContent: '还没有对话。说点什么开始吧～' })); return; }
    history.replaceChildren(...groupSessions(list.slice(0, 60)).flatMap(([name, items]) => [
      el('div', { className: 'drawer-group', textContent: name }),
      ...items.map((s) => {
        const b = el('button', { type: 'button', className: `drawer-item${s.id === cur ? ' current' : ''}`, textContent: s.title || '新对话' });
        b.addEventListener('click', () => { close(); onOpenSession(s.id); });
        return b;
      })
    ]));
  }

  function open() {
    refresh();
    document.body.classList.add('drawer-open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false;
  }
  function close() {
    document.body.classList.remove('drawer-open');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.hidden = true;
  }
  scrim.addEventListener('click', close);

  // 手势：从左边缘右滑打开，抽屉里左滑关闭
  let sx = null, sy = 0;
  addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const isOpen = document.body.classList.contains('drawer-open');
    sx = (isOpen || t.clientX < 24) ? t.clientX : null;
    sy = t.clientY;
  }, { passive: true });
  addEventListener('touchend', (e) => {
    if (sx === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
    sx = null;
    if (dy > 60) return;
    if (dx > 60 && !document.body.classList.contains('drawer-open')) open();
    else if (dx < -60 && document.body.classList.contains('drawer-open')) close();
  }, { passive: true });

  return { open, close, refresh, get isOpen() { return document.body.classList.contains('drawer-open'); } };
}
