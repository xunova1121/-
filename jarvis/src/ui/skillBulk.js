/**
 * “已安装”技能列表上面的搜索框和多选删除：一个仓库能装进来二三十个技能，一个个卸太慢。
 *   搜索    按名字、中文标题、说明、来源过滤（只是隐藏，不改数据）
 *   多选    点“多选”后每张卡片出现勾选框；“全选”只选当前搜得到的；删除要再点一次确认
 */
import './skillBulk.css';

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/** 一个技能用来搜索的文字 */
export const searchText = (p, title = '') => [p.name, title, p.description, p.source].filter(Boolean).join(' ').toLocaleLowerCase();

/** 搜索词是否命中（空格分开的几个词都要命中） */
export function matches(text, query) {
  const words = String(query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w));
}

/**
 * @param {{ list: HTMLElement, onDelete: (names: string[]) => Promise<void> }} o
 */
export function createSkillBulk({ list, onDelete }) {
  const picked = new Set();
  let picking = false;
  const search = el('input', { type: 'search', className: 'skill-search', placeholder: '搜索已安装技能（名字、说明、来源）' });
  search.setAttribute('aria-label', '搜索已安装技能');
  const counter = el('span', { className: 'muted small skill-filter-count' });
  const pickBtn = el('button', { type: 'button', className: 'btn ghost sm', textContent: '多选' });
  const allBtn = el('button', { type: 'button', className: 'btn ghost sm', textContent: '全选', hidden: true });
  const delBtn = el('button', { type: 'button', className: 'btn sm danger skill-bulk-delete', hidden: true, disabled: true });
  const bar = el('div', { className: 'skill-bulk' }, search, counter, pickBtn, allBtn, delBtn);
  const noMatch = el('p', { className: 'muted small skill-no-match', textContent: '没有匹配的技能，换个关键词试试。', hidden: true });
  list.before(bar);
  list.after(noMatch);

  const cards = () => [...list.querySelectorAll(':scope > .skill')];
  const visible = () => cards().filter((c) => !c.hidden);

  function update() {
    const names = new Set(cards().map((c) => c.dataset.name));
    for (const n of [...picked]) if (!names.has(n)) picked.delete(n);
    list.classList.toggle('picking', picking);
    pickBtn.textContent = picking ? '取消' : '多选';
    allBtn.hidden = delBtn.hidden = !picking;
    const shown = visible();
    allBtn.textContent = shown.length && shown.every((c) => picked.has(c.dataset.name)) ? '全不选' : '全选';
    delBtn.disabled = !picked.size;
    if (delBtn.dataset.confirm !== '1') delBtn.textContent = `删除所选（${picked.size}）`;
    for (const c of cards()) {
      const box = c.querySelector('.skill-pick input');
      if (box) box.checked = picked.has(c.dataset.name);
      c.classList.toggle('picked', picking && picked.has(c.dataset.name));
    }
  }

  /** 按搜索词显示 / 隐藏卡片 */
  function apply() {
    let shown = 0;
    const all = cards();
    for (const c of all) {
      c.hidden = !matches(c.dataset.search || '', search.value);
      if (!c.hidden) shown++;
    }
    counter.textContent = search.value.trim() ? `${shown} / ${all.length}` : '';
    noMatch.hidden = !(all.length && !shown);
    update();
  }

  /** 每张卡片：记下搜索用的文字，多选时前面放勾选框 */
  function decorate(card, p, title = '') {
    card.dataset.name = p.name;
    card.dataset.search = searchText(p, title);
    const box = el('input', { type: 'checkbox', checked: picked.has(p.name) });
    box.setAttribute('aria-label', `选择 ${p.name}`);
    box.addEventListener('change', () => {
      if (box.checked) picked.add(p.name);
      else picked.delete(p.name);
      resetConfirm();
      update();
    });
    card.prepend(el('label', { className: 'skill-pick' }, box, el('span', { textContent: '选择' })));
    return card;
  }

  let confirmTimer = 0;
  function resetConfirm() {
    clearTimeout(confirmTimer);
    delBtn.dataset.confirm = '';
  }

  search.addEventListener('input', apply);
  pickBtn.addEventListener('click', () => {
    picking = !picking;
    if (!picking) picked.clear();
    resetConfirm();
    update();
  });
  allBtn.addEventListener('click', () => {
    const shown = visible().map((c) => c.dataset.name);
    const all = shown.every((n) => picked.has(n));
    for (const n of shown) {
      if (all) picked.delete(n);
      else picked.add(n);
    }
    resetConfirm();
    update();
  });
  delBtn.addEventListener('click', async () => {
    if (!picked.size) return;
    // 删除要点两次：第一次变成“确认删除”，3 秒内再点才删
    if (delBtn.dataset.confirm !== '1') {
      delBtn.dataset.confirm = '1';
      delBtn.textContent = `确认删除 ${picked.size} 个`;
      confirmTimer = setTimeout(() => {
        resetConfirm();
        update();
      }, 3000);
      return;
    }
    resetConfirm();
    const names = [...picked];
    delBtn.disabled = true;
    delBtn.textContent = '正在删除…';
    try {
      await onDelete(names);
    } finally {
      picked.clear();
      picking = false;
      update();
    }
  });

  return { decorate, apply };
}
