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
const GROUP_HUE = { 置顶: 30, 今天: 255, 昨天: 200, '近 7 天': 165, 更早: 220 };
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

/** 纯函数：会话按日期分组（置顶 / 今天 / 昨天 / 近 7 天 / 更早） */
export function groupSessions(list, now = Date.now()) {
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = day(now);
  const groups = [['今天', []], ['昨天', []], ['近 7 天', []], ['更早', []]];
  const pinned = [];
  for (const s of list) {
    if (s.pinned) { pinned.push(s); continue; }
    const d = day(s.updatedAt ?? s.createdAt ?? now);
    const i = d >= today ? 0 : d >= today - 864e5 ? 1 : d >= today - 7 * 864e5 ? 2 : 3;
    groups[i][1].push(s);
  }
  return [['置顶', pinned], ...groups].filter(([, items]) => items.length);
}

/**
 * @param {{ onNew: () => void, onOpenSession: (id: string) => void, onPanel: (name: string) => void, listSessions: () => Promise<object[]>, cachedSessions?: () => object[] | null, currentId: () => string, icons: Record<string, string>, onRename?: (id: string, title: string) => Promise<void>, onPin?: (id: string, pinned: boolean) => Promise<void>, onDelete?: (id: string) => Promise<void> }} o
 */
export function initDrawer({ onNew, onOpenSession, onPanel, listSessions, cachedSessions = () => null, currentId, icons = {}, onRename, onPin, onDelete, onExport, searchContent }) {
  const scrim = el('div', { className: 'drawer-scrim', hidden: true });
  const history = el('div', { className: 'drawer-history' });
  // 按标题搜对话：有关键词时列出所有匹配的（不受“只显示 8 条”限制）
  const search = el('input', { type: 'search', className: 'drawer-search', placeholder: '搜索对话', enterKeyHint: 'search' });
  // 标题马上筛；停手 0.4 秒后再按内容搜（服务器模式下由服务器搜）
  let searchTimer = 0, searchSeq = 0;
  search.addEventListener('input', () => {
    render(lastList);
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (!q || !searchContent) return;
    searchTimer = setTimeout(async () => {
      const mine = ++searchSeq;
      const hits = await searchContent(q).catch(() => []);
      if (mine !== searchSeq || search.value.trim() !== q) return;
      const titles = new Set([...history.querySelectorAll('.drawer-row')].map((r) => r.dataset.id));
      const more = hits.filter((h) => h.snippet && !titles.has(h.id));
      if (!more.length) return;
      history.querySelector('.drawer-empty')?.remove();
      history.append(el('div', { className: 'drawer-group', textContent: '内容里提到' }), ...more.map((h) => {
        const b = el('button', { type: 'button', className: 'drawer-hit' }, el('b', { textContent: h.title || '新对话' }), el('span', { textContent: h.snippet }));
        b.addEventListener('click', () => { close(); onOpenSession(h.id); });
        return b;
      }));
    }, 400);
  });
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
    el('section', { className: 'drawer-hist' }, el('h3', { textContent: '历史对话' }), search, history),
    el('footer', { className: 'drawer-foot' }, memBtn, settingsBtn)
  );
  drawer.setAttribute('aria-hidden', 'true');
  document.body.append(scrim, drawer);

  let expanded = false;
  let lastList = [];
  let loading = 0;
  /** 先用手机上留的那份马上画出来，再从服务器取最新的重画（服务器慢时不用干等） */
  async function refresh() {
    const cached = cachedSessions();
    if (cached?.length) render(cached);
    else if (!lastList.length) history.replaceChildren(el('p', { className: 'drawer-empty', textContent: '正在读取对话…' }));
    const mine = ++loading;
    const list = await listSessions().catch(() => null);
    if (mine !== loading) return; // 又刷新了一次：以后来的为准
    if (list) render(list);
    else if (!cached?.length && !lastList.length) history.replaceChildren(el('p', { className: 'drawer-empty', textContent: '读不到对话列表（网络不好？），稍后再打开菜单试试' }));
  }
  function render(list) {
    lastList = list;
    const cur = currentId();
    if (!list.length) { history.replaceChildren(el('p', { className: 'drawer-empty', textContent: '还没有对话。说点什么开始吧～' })); return; }
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = list.filter((x) => String(x.title || '').toLowerCase().includes(q));
      history.replaceChildren(...(hits.length ? hits.slice(0, 100).map((x) => row(x, cur)) : [el('p', { className: 'drawer-empty', textContent: '没有找到标题里带这个词的对话' })]));
      return;
    }
    // 默认只列最近几条，其余点“展开更多”再显示（置顶的总是显示）
    let shown = expanded ? list.slice(0, 60) : [...list.filter((x) => x.pinned), ...list.filter((x) => !x.pinned).slice(0, SHOW_FIRST)];
    // 当前对话排在后面（被收起来了）：也显示出来，一眼能看到自己在哪个对话里
    const curItem = list.find((x) => x.id === cur);
    if (curItem && !shown.includes(curItem)) shown = [...shown, curItem];
    const groups = groupSessions(shown).flatMap(([name, items]) => {
      const g = el('div', { className: 'drawer-group', textContent: name });
      g.style.setProperty('--h', GROUP_HUE[name] ?? 250);
      return [g, ...items.map((x) => row(x, cur))];
    });
    let tail;
    if (!expanded && list.length > shown.length) {
      tail = el('button', { type: 'button', className: 'drawer-more', textContent: `展开更多（还有 ${Math.min(list.length, 60) - Math.min(shown.length, 60)} 条）` });
      tail.addEventListener('click', () => { expanded = true; render(lastList); });
    } else if (expanded) {
      tail = el('div', { className: 'drawer-end' },
        list.length > 60 ? '更早的对话在“全部对话”里 · ' : '',
        el('button', { type: 'button', className: 'drawer-more inline', textContent: '收起' }));
      tail.querySelector('button').addEventListener('click', () => { expanded = false; render(lastList); });
    } else tail = el('p', { className: 'drawer-end', textContent: '没有更多对话了～' });
    history.replaceChildren(...groups, tail);
  }
  /** 一条对话：点标题打开；右边“⋯”展开重命名 / 置顶 / 删除 */
  function row(x, cur) {
    const b = el('button', { type: 'button', className: `drawer-item${x.id === cur ? ' current' : ''}` },
      el('span', { className: 'drawer-item-icon', ariaHidden: 'true' }),
      el('span', { className: 'drawer-item-t', textContent: x.title || '新对话' }),
      el('time', { textContent: shortTime(x.updatedAt ?? x.createdAt ?? Date.now()) }));
    b.addEventListener('click', () => { close(); onOpenSession(x.id); });
    const more = el('button', { type: 'button', className: 'drawer-item-more', textContent: '⋯', title: '重命名 / 置顶 / 删除', ariaLabel: `管理「${x.title || '新对话'}」` });
    const wrap = el('div', { className: 'drawer-row' }, b, more);
    wrap.dataset.id = x.id;
    more.addEventListener('click', () => {
      const open = wrap.querySelector('.drawer-menu');
      for (const m of history.querySelectorAll('.drawer-menu')) m.remove();
      if (open) return;
      const act = (label, fn, cls = '') => {
        const btn = el('button', { type: 'button', className: cls, textContent: label });
        btn.addEventListener('click', async () => {
          menu.remove();
          try { await fn(); } catch (e) { globalThis.console?.warn('[抽屉]', e); }
          refresh();
        });
        return btn;
      };
      const menu = el('div', { className: 'drawer-menu' },
        act('重命名', async () => {
          let t = null;
          try { t = globalThis.prompt('给这段对话起个名字', x.title || ''); } catch { /* 不支持弹窗 */ }
          t = String(t ?? '').trim().slice(0, 60);
          if (t && t !== x.title) await onRename?.(x.id, t);
        }),
        act(x.pinned ? '取消置顶' : '置顶', () => onPin?.(x.id, !x.pinned)),
        ...(onExport ? [act('复制全部内容', () => onExport(x.id, 'copy')), act('导出为 Word', () => onExport(x.id, 'docx')), act('导出为 Markdown', () => onExport(x.id, 'md'))] : []),
        act('删除', async () => {
          let ok = false;
          try { ok = globalThis.confirm(`删除「${x.title || '新对话'}」？删除后找不回来。`); } catch { /* 不支持弹窗 */ }
          if (ok) await onDelete?.(x.id);
        }, 'danger'));
      wrap.append(menu);
    });
    return wrap;
  }

  function open() {
    expanded = false;
    search.value = '';
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
