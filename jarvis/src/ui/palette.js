/**
 * 命令面板（Ctrl / ⌘ + K）：搜索并执行任何操作——打开面板、切换形态与开关、点名技能、常用任务。
 */
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/** 不区分大小写、忽略空格的子序列匹配，返回分数（越小越靠前），不匹配返回 -1 */
export function score(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return at;
  let i = 0;
  let gaps = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return 100 + gaps;
  }
  return -1;
}

/**
 * @param {{ commands: () => Array<{ id: string, group: string, title: string, hint?: string, keys?: string, run: () => void }> }} o
 */
export function initPalette({ commands }) {
  const input = el('input', { type: 'text', className: 'palette-input', placeholder: '搜索命令、面板、技能……', spellcheck: false });
  input.setAttribute('aria-label', '搜索命令');
  const list = el('ul', { className: 'palette-list', role: 'listbox' });
  const box = el('div', { className: 'palette', role: 'dialog' }, input, list,
    el('div', { className: 'palette-foot' }, el('span', {}, el('kbd', { textContent: '↑↓' }), ' 选择'), el('span', {}, el('kbd', { textContent: 'Enter' }), ' 执行'), el('span', {}, el('kbd', { textContent: 'Esc' }), ' 关闭')));
  box.setAttribute('aria-label', '命令面板');
  const overlay = el('div', { className: 'palette-overlay', hidden: true }, box);
  document.body.append(overlay);
  let shown = [];
  let sel = 0;
  let lastFocus = null;

  function render() {
    const q = input.value.trim();
    shown = commands()
      .map((c) => ({ c, s: score(q, `${c.title} ${c.hint ?? ''} ${c.group}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.c)
      .slice(0, 40);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let group = '';
    const rows = [];
    shown.forEach((c, i) => {
      if (!q && c.group !== group) { group = c.group; rows.push(el('li', { className: 'palette-group', textContent: group })); }
      const li = el('li', { className: `palette-item${i === sel ? ' on' : ''}`, role: 'option' },
        el('span', { className: 'palette-title', textContent: c.title }),
        c.hint ? el('span', { className: 'palette-hint', textContent: c.hint }) : null,
        c.keys ? el('kbd', { textContent: c.keys }) : null);
      li.setAttribute('aria-selected', String(i === sel));
      li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
      li.addEventListener('click', () => run(i));
      rows.push(li);
    });
    if (!shown.length) rows.push(el('li', { className: 'palette-empty', textContent: '没有匹配的命令。按 Enter 把这句话直接发给未央。' }));
    list.replaceChildren(...rows);
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    lastFocus = document.activeElement;
    overlay.hidden = false;
    input.value = '';
    sel = 0;
    render();
    input.focus();
  }
  function close() {
    overlay.hidden = true;
    lastFocus?.focus?.();
  }
  function run(i) {
    const c = shown[i];
    close();
    c?.run();
  }

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown.length) run(sel);
      else { const text = input.value.trim(); close(); if (text) onFallback?.(text); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.hidden) open(); else close();
    }
  }, true);

  let onFallback = null;
  return {
    open,
    close,
    get isOpen() { return !overlay.hidden; },
    /** 没有匹配的命令时，把输入当作一句话发给未央 */
    set onFallback(fn) { onFallback = fn; }
  };
}
