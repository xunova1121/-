/**
 * “技能”面板：安装（GitHub / zip / SKILL.md / 推荐列表）、启用停用、查看、卸载；
 * 以及输入框里的“/技能名”自动补全。
 */
import * as packs from '../agent/skillPacks.js';
import { BUILTIN_SKILLS, GITHUB_SKILLS } from '../agent/skillCatalog.js';
import { parseFrontmatter } from '../agent/skillPacks.js';
import { renderBlocks } from './transcript.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/**
 * @param {{ toast: (t: string) => void, onUse: (name: string) => void, onChange?: () => void }} o
 */
export function initSkillsPanel({ toast, onUse, onChange }) {
  const status = $('#skill-status');
  let installed = [];

  async function refresh() {
    installed = await packs.list().catch(() => []);
    $('#skill-count').textContent = `${installed.filter((p) => p.enabled).length} / ${installed.length} 个启用`;
    const list = $('#skill-list');
    list.replaceChildren(...(installed.length ? installed.map(card) : [el('li', { className: 'empty', textContent: '还没有安装技能。从下方推荐里一键安装，或粘贴 GitHub 地址。' })]));
    renderRecommend();
    onChange?.(installed);
  }

  function card(p) {
    const toggle = el('input', { type: 'checkbox', checked: p.enabled, title: p.enabled ? '停用' : '启用' });
    toggle.addEventListener('change', async () => { await packs.setEnabled(p.name, toggle.checked); refresh(); });
    const view = el('button', { type: 'button', className: 'btn ghost sm', textContent: '查看' });
    view.addEventListener('click', () => show(p));
    const use = el('button', { type: 'button', className: 'btn ghost sm', textContent: '使用', disabled: !p.enabled });
    use.addEventListener('click', () => onUse(p.name));
    const del = el('button', { type: 'button', className: 'btn ghost sm danger', textContent: '卸载' });
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '确认卸载'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = '卸载'; }, 3000); return; }
      await packs.remove(p.name);
      if ($('#skill-viewer').dataset.name === p.name) $('#skill-viewer').hidden = true;
      toast(`已卸载技能：${p.name}`);
      refresh();
    });
    const files = Object.keys(p.files || {}).length;
    return el('li', { className: `skill${p.enabled ? '' : ' off'}` },
      el('div', { className: 'skill-top' },
        el('label', { className: 'switch', title: '启用 / 停用' }, toggle, el('span')),
        el('code', { className: 'skill-name', textContent: `/${p.name}` }),
        el('span', { className: 'skill-src', textContent: p.source, title: p.source })),
      el('p', { className: 'skill-desc', textContent: p.description || '（没有描述）' }),
      el('div', { className: 'skill-actions' },
        el('span', { className: 'muted small', textContent: files ? `附带 ${files} 个文件` : '' }), view, use, del));
  }

  function show(p) {
    const v = $('#skill-viewer');
    v.dataset.name = p.name;
    const body = el('div', { className: 'skill-doc' });
    renderBlocks(body, p.body);
    const close = el('button', { type: 'button', className: 'x-btn', title: '关闭', textContent: '✕' });
    close.addEventListener('click', () => { v.hidden = true; });
    const files = Object.keys(p.files || {});
    v.replaceChildren(...[
      el('div', { className: 'skill-viewer-head' }, el('code', { textContent: `${p.name}/SKILL.md` }), close),
      body,
      files.length ? el('div', { className: 'muted small' }, `附带文件：${files.join('、')}`) : null,
      p.skipped?.length ? el('div', { className: 'muted small' }, `未安装：${p.skipped.slice(0, 8).join('、')}${p.skipped.length > 8 ? ' …' : ''}`) : null
    ].filter(Boolean));
    v.hidden = false;
    v.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderRecommend() {
    const have = new Set(installed.map((p) => p.name));
    const builtin = BUILTIN_SKILLS.map((s) => {
      const { meta } = parseFrontmatter(s.text);
      return tile({ title: s.title, name: meta.name, desc: meta.description.replace(/。.*$/, '。'), tag: '内置', installed: have.has(meta.name), install: () => packs.installFromText(s.text, '内置') });
    });
    const gh = GITHUB_SKILLS.map((s) => tile({ title: s.title, name: s.name, desc: s.desc, tag: 'GitHub', installed: have.has(s.name), install: () => fromGitHub(s.url) }));
    $('#skill-recommend').replaceChildren(...builtin, ...gh);
  }

  function tile({ title, name, desc, tag, installed: on, install }) {
    const btn = el('button', { type: 'button', className: `btn sm${on ? ' ghost' : ''}`, textContent: on ? '已安装' : '安装', disabled: on });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '安装中…';
      try {
        const p = await install();
        if (p) { toast(`已安装技能：${p.name}`); await refresh(); }
      } catch (e) {
        status.textContent = `安装失败：${e.message}`;
        btn.disabled = false;
        btn.textContent = '安装';
      }
    });
    return el('div', { className: 'skill-tile' },
      el('div', { className: 'skill-tile-head' }, el('strong', { textContent: title }), el('span', { className: `tag${tag === 'GitHub' ? ' gh' : ''}`, textContent: tag })),
      el('code', { className: 'skill-name', textContent: `/${name}` }),
      el('p', { textContent: desc }),
      btn);
  }

  async function fromGitHub(url) {
    status.textContent = '正在连接 GitHub…';
    try {
      const p = await packs.installFromGitHub(url, { onProgress: (m) => { status.textContent = m; } });
      status.textContent = `已安装「${p.name}」${p.skipped.length ? `（${p.skipped.length} 个文件未安装：二进制或过大）` : ''}`;
      return p;
    } catch (e) {
      status.textContent = `安装失败：${/Failed to fetch|NetworkError/i.test(e.message) ? '连不上 GitHub，请检查网络' : e.message}`;
      throw Object.assign(e, { shown: true });
    }
  }

  $('#btn-skill-url').addEventListener('click', async () => {
    const url = $('#skill-url').value.trim();
    if (!url) { status.textContent = '请先粘贴 GitHub 地址'; return; }
    try {
      const p = await fromGitHub(url);
      toast(`已安装技能：${p.name}`);
      $('#skill-url').value = '';
      refresh();
    } catch { /* 已在状态行显示 */ }
  });
  $('#skill-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-skill-url').click(); });
  $('#btn-skill-file').addEventListener('click', () => $('#skill-input').click());
  $('#skill-input').addEventListener('change', async (e) => {
    for (const f of e.target.files) await installFile(f);
    e.target.value = '';
  });

  async function installFile(f) {
    try {
      const p = /\.zip$/i.test(f.name) ? await packs.installFromZip(await f.arrayBuffer(), f.name) : await packs.installFromText(await f.text(), f.name);
      status.textContent = `已安装「${p.name}」${p.skipped.length ? `（${p.skipped.length} 个文件未安装）` : ''}`;
      toast(`已安装技能：${p.name}`);
      await refresh();
      return p;
    } catch (err) {
      status.textContent = `${f.name}：${err.message}`;
      return null;
    }
  }

  // ------------------------------------------------------------ 输入框 “/” 自动补全
  const prompt = $('#prompt');
  const menu = el('ul', { className: 'slash-menu', id: 'slash-menu', hidden: true, role: 'listbox' });
  prompt.closest('.composer').append(menu);
  let items = [];
  let sel = 0;
  function updateMenu() {
    const m = prompt.value.match(/^\/([^\s/]*)$/);
    const on = installed.filter((p) => p.enabled);
    items = m ? on.filter((p) => p.name.toLowerCase().includes(m[1].toLowerCase())).slice(0, 8) : [];
    menu.hidden = !items.length;
    if (!items.length) return;
    sel = Math.min(sel, items.length - 1);
    menu.replaceChildren(...items.map((p, i) => {
      const li = el('li', { role: 'option', className: i === sel ? 'on' : '' },
        el('code', { textContent: `/${p.name}` }), el('span', { textContent: p.description }));
      li.setAttribute('aria-selected', String(i === sel));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      return li;
    }));
  }
  function pick(i) {
    prompt.value = `/${items[i].name} `;
    menu.hidden = true;
    prompt.focus();
    prompt.dispatchEvent(new Event('input'));
  }
  prompt.addEventListener('input', () => { sel = 0; updateMenu(); });
  prompt.addEventListener('blur', () => { setTimeout(() => { menu.hidden = true; }, 100); });
  prompt.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      updateMenu();
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(sel);
    } else if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      menu.hidden = true;
    }
  }, true);

  refresh();
  return { refresh, installFile, get installed() { return installed; } };
}
