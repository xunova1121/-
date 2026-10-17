/**
 * 手机左侧抽屉（取代底部菜单栏）：标题 → 开启新对话 → 功能宫格（原底部菜单） → 历史对话（按今天 / 昨天 / 更早分组）。
 * 点左上角菜单按钮或从屏幕左边缘向右滑打开；点遮罩、向左滑或选了某一项后关闭。
 */
// [面板, 名字, 图标色相]：每个功能一种颜色，一眼能分开
const FEATURES = [
  ['workspace', '工作区', 210], ['knowledge', '知识库', 165], ['mind', '记忆进化', 280], ['skills', '技能', 38],
  ['models', '模型', 245], ['system', '定时任务', 15], ['settings', '设置', 225], ['sessions', '全部对话', 320]
];
/** 抽屉里默认显示的历史对话条数 */
export const SHOW_FIRST = 8;
const GROUP_HUE = { 今天: 255, 昨天: 200, '近 7 天': 165, 更早: 220 };
const pad = (n) => String(n).padStart(2, '0');
/** 历史对话右侧的时间：今天显示几点，其他显示月/日 */
export function shortTime(t, now = Date.now()) {
  const d = new Date(t);
  return new Date(now).toDateString() === d.toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

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
  const grid = el('div', { className: 'drawer-grid' }, ...FEATURES.map(([id, label, hue]) => {
    const b = el('button', { type: 'button', className: 'drawer-feat' });
    b.style.setProperty('--h', hue);
    b.innerHTML = icons[id] || '';
    b.append(el('span', { textContent: label }));
    b.addEventListener('click', () => { close(); onPanel(id); });
    return b;
  }));
  const newBtn = el('button', { type: 'button', className: 'drawer-new' });
  newBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h11M4 5v11h4v4l4-4h8V11"/><path d="M19 3v6M16 6h6"/></svg>';
  newBtn.append('开启新对话');
  newBtn.addEventListener('click', () => { close(); onNew(); });
  const settingsBtn = el('button', { type: 'button', className: 'drawer-gear', title: '设置', ariaLabel: '设置' });
  settingsBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle cx="12" cy="12" r="3"/></svg>';
  settingsBtn.addEventListener('click', () => { close(); onPanel('settings'); });
  const memBtn = el('button', { type: 'button', className: 'drawer-me' },
    el('span', { className: 'drawer-avatar', textContent: '我' }),
    el('span', {}, el('b', { textContent: '我的未央' }), el('small', { textContent: '记忆与进化' })));
  memBtn.addEventListener('click', () => { close(); onPanel('mind'); });
  const drawer = el('aside', { className: 'drawer', id: 'drawer', ariaLabel: '菜单' },
    el('div', { className: 'drawer-head' },
      el('span', { className: 'drawer-logo', ariaHidden: 'true' }),
      el('div', { className: 'drawer-title' }, el('strong', { textContent: '未央' }), el('small', { textContent: 'WEIYANG AI · 个人智能助手' }))),
    newBtn,
    el('section', { className: 'drawer-card' }, el('h3', { textContent: '功能' }), grid),
    el('section', { className: 'drawer-hist' }, el('h3', { textContent: '历史对话' }), history),
    el('footer', { className: 'drawer-foot' }, memBtn, settingsBtn)
  );
  drawer.setAttribute('aria-hidden', 'true');
  document.body.append(scrim, drawer);

  let expanded = false;
  async function refresh() {
    const list = await listSessions().catch(() => []);
    const cur = currentId();
    if (!list.length) { history.replaceChildren(el('p', { className: 'drawer-empty', textContent: '还没有对话。说点什么开始吧～' })); return; }
    // 默认只列最近几条，其余点“展开更多”再显示
    const shown = expanded ? list.slice(0, 60) : list.slice(0, SHOW_FIRST);
    const groups = groupSessions(shown).flatMap(([name, items]) => {
      const g = el('div', { className: 'drawer-group', textContent: name });
      g.style.setProperty('--h', GROUP_HUE[name] ?? 250);
      return [g, ...items.map((s) => {
        const b = el('button', { type: 'button', className: `drawer-item${s.id === cur ? ' current' : ''}` },
          el('span', { className: 'drawer-item-icon', ariaHidden: 'true' }),
          el('span', { className: 'drawer-item-t', textContent: s.title || '新对话' }),
          el('time', { textContent: shortTime(s.updatedAt ?? s.createdAt ?? Date.now()) }));
        b.addEventListener('click', () => { close(); onOpenSession(s.id); });
        return b;
      })];
    });
    let tail;
    if (!expanded && list.length > SHOW_FIRST) {
      tail = el('button', { type: 'button', className: 'drawer-more', textContent: `展开更多（还有 ${Math.min(list.length, 60) - SHOW_FIRST} 条）` });
      tail.addEventListener('click', () => { expanded = true; refresh(); });
    } else if (expanded) {
      tail = el('div', { className: 'drawer-end' },
        list.length > 60 ? '更早的对话在“全部对话”里 · ' : '',
        el('button', { type: 'button', className: 'drawer-more inline', textContent: '收起' }));
      tail.querySelector('button').addEventListener('click', () => { expanded = false; refresh(); });
    } else tail = el('p', { className: 'drawer-end', textContent: '没有更多对话了～' });
    history.replaceChildren(...groups, tail);
  }

  function open() {
    expanded = false;
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
