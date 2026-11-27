/**
 * PPT 模板（设计稿 P4 的“先选一个喜欢的样子”、P5 模板库与样张预览）。
 * 缩略图是排版引擎真实生成、LibreOffice 转出来的样张（scripts/make-ppt-templates.mjs），取不到图时只显示名字。
 */
import { PPT_TEMPLATES, TEMPLATE_SCENES, pptTemplate } from '../agent/pptTemplates.js';
import { themeById } from '../agent/themes.js';
import { pptSourceGallery } from './pptSourceGallery.js';

// 样张缩略图随构建打包（手机版、单文件版也有）；文件名 <模板>-<页>.jpg
const THUMBS = import.meta.glob('../assets/ppt-templates/*.jpg', { eager: true, query: '?url', import: 'default' });
const templateThumb = (id, page = 1) => THUMBS[`../assets/ppt-templates/${id}-${page}.jpg`] || '';

const themeName = (id) => themeById(id)?.name || id;
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
function thumb(id, page = 1) {
  const src = templateThumb(id, page);
  const img = el('img', { className: `wy-tpl-thumb${src ? '' : ' missing'}`, src, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.classList.add('missing'), { once: true });
  return img;
}

/** 模板卡片：缩略图 + 名字 + 场景·风格；selected 时带勾 */
export function templateCard(tpl, { selected = false, onClick }) {
  const b = el('button', { type: 'button', className: `wy-tpl-card${selected ? ' on' : ''}` },
    el('span', { className: 'wy-tpl-frame' }, thumb(tpl.id), el('span', { className: 'wy-tpl-fallback', textContent: tpl.name })),
    el('b', { textContent: tpl.name }),
    el('small', { textContent: `${TEMPLATE_SCENES[tpl.scene]} · ${themeName(tpl.theme)}` }));
  b.dataset.template = tpl.id;
  b.setAttribute('aria-pressed', String(selected));
  b.addEventListener('click', onClick);
  return b;
}

/** 起始页里的模板区：显示 4 个（选中的排第一），“全部模板”进模板库；再点一次已选的取消 */
export function templatePicker({ value = '', onChange, onMore }) {
  const root = el('section', { className: 'wy-tpl-pick' });
  const draw = (current) => {
    const chosen = pptTemplate(current);
    const list = [...(chosen ? [chosen] : []), ...PPT_TEMPLATES.filter((x) => x.id !== current)].slice(0, 4);
    const more = el('button', { type: 'button', className: 'wy-tpl-more', textContent: '全部模板 ›' });
    more.addEventListener('click', onMore);
    root.replaceChildren(
      el('div', { className: 'wy-agent-start-label' }, el('b', { textContent: '先选一个喜欢的样子' }), more),
      el('div', { className: 'wy-tpl-grid' }, ...list.map((x) => templateCard(x, { selected: x.id === current, onClick: () => { const next = x.id === current ? '' : x.id; onChange(next); draw(next); } }))),
      el('small', { className: 'wy-tpl-chosen', textContent: chosen ? `已选：${chosen.name}（再点一次取消）` : '不选也可以，未央会按内容自动挑风格' }));
  };
  draw(value);
  return { root, set: draw };
}

/** 模板库浮层：场景筛选 → 点模板看 3 页样张 → “用这个模板” */
export function createTemplateLibrary({ onPick, onImport }) {
  let scene = '';
  const back = el('button', { type: 'button', className: 'wy-agents-back', ariaLabel: '返回' });
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  const title = el('h2', { textContent: 'PPT 模板' });
  const body = el('div', { className: 'wy-agents-body' });
  const root = el('section', { className: 'wy-agents wy-tpl-library', hidden: true, ariaLabel: 'PPT 模板' },
    el('header', { className: 'wy-agents-bar' }, back, title), body);
  root.setAttribute('role', 'dialog');
  document.body.append(root);
  let previewing = null;
  back.addEventListener('click', () => (previewing ? list() : close()));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  function list() {
    previewing = null;
    title.textContent = 'PPT 模板';
    const chips = el('div', { className: 'wy-agents-chips', role: 'tablist' }, ...[['', '全部'], ...Object.entries(TEMPLATE_SCENES)].map(([id, label]) => {
      const c = el('button', { type: 'button', className: `wy-agents-chip${id === scene ? ' on' : ''}`, textContent: label, role: 'tab' });
      c.dataset.scene = id;
      c.setAttribute('aria-selected', String(id === scene));
      c.addEventListener('click', () => { scene = id; list(); });
      return c;
    }));
    const shown = PPT_TEMPLATES.filter((x) => !scene || x.scene === scene);
    body.replaceChildren(chips, el('div', { className: 'wy-tpl-grid wide' }, ...shown.map((x) => templateCard(x, { onClick: () => preview(x) }))),
      el('p', { className: 'wy-agent-start-note', textContent: '样张由未央的排版引擎生成，配图是原创插画；实际内容按你的资料来写。' }));
    if (onImport) body.prepend(pptSourceGallery({ onImport }));
  }
  function preview(tpl) {
    previewing = tpl;
    title.textContent = tpl.name;
    const use = el('button', { type: 'button', className: 'wy-tpl-use', textContent: '用这个模板' });
    use.addEventListener('click', () => { close(); onPick(tpl.id); });
    body.replaceChildren(
      el('div', { className: 'wy-tpl-pages' }, ...[1, 2, 3].map((n) => el('span', { className: 'wy-tpl-frame big' }, thumb(tpl.id, n), el('span', { className: 'wy-tpl-fallback', textContent: `${tpl.name} · 第${n}页` })))),
      el('p', { className: 'wy-agent-start-intro', textContent: tpl.desc }),
      el('div', { className: 'wy-tpl-outline' }, el('b', { textContent: '推荐结构' }), el('span', { textContent: tpl.outline.join(' → ') })),
      el('div', { className: 'wy-tpl-outline' }, el('b', { textContent: '自带配图' }), el('span', { textContent: tpl.art.map(([, , usage]) => usage).join('、') })),
      tpl.credit ? el('div', { className: 'wy-tpl-outline' }, el('b', { textContent: '出处' }), el('span', { textContent: tpl.credit })) : null,
      use);
    body.scrollTop = 0;
  }
  function open() { list(); root.hidden = false; document.body.classList.add('wy-agents-open'); requestAnimationFrame(() => back.focus()); }
  function close() { if (root.hidden) return; root.hidden = true; document.body.classList.remove('wy-agents-open'); }
  return { root, open, close, get isOpen() { return !root.hidden; } };
}
