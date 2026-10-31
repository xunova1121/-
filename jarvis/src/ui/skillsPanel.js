/**
 * “技能”面板：安装（GitHub / zip / SKILL.md / 推荐列表）、启用停用、查看、卸载；
 * 以及输入框里的“/技能名”自动补全。
 */
import { MOBILE } from '../config.js';
import './mobileImprovements.css';
import { skillCompatibility } from '../agent/skillCompatibility.js';
import * as packs from '../agent/skillPacks.js';
import { BUILTIN_SKILLS, MORE_BUILTIN_SKILLS, GITHUB_SKILLS } from '../agent/skillCatalog.js';
import { parseFrontmatter } from '../agent/skillPacks.js';
import { renderBlocks } from './transcript.js';
import { createSkillBulk } from './skillBulk.js';

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
  // 服务器模式：服务器上自己装的技能（对话里让未央装的）本机没有，也列出来，能搜、能删
  let serverOnly = [];

  // 卸载：本机删掉；服务器模式下服务器上的也删掉（任务在服务器上做，不删的话照样会用到）
  async function removeSkills(names) {
    for (const n of names) await packs.remove(n);
    if ($('#skill-viewer').dataset.name && names.includes($('#skill-viewer').dataset.name)) $('#skill-viewer').hidden = true;
    const c = server();
    let note = '';
    if (c?.removeSkill) {
      const failed = [];
      for (const n of names) await c.removeSkill(n).catch(() => failed.push(n));
      note = failed.length ? `；服务器上没删掉：${failed.join('、')}（服务器版本太旧或连不上，更新服务器后再删一次）` : '（服务器上也删了）';
      refreshServer();
    }
    toast(names.length === 1 ? `已卸载技能：${names[0]}${note}` : `已删除 ${names.length} 个技能${note}`);
    await refresh();
  }
  const bulk = createSkillBulk({ list: $('#skill-list'), onDelete: removeSkills });

  async function refresh() {
    installed = await packs.list().catch(() => []);
    $('#skill-count').textContent = `${installed.filter((p) => p.enabled).length} / ${installed.length} 个启用`;
    const list = $('#skill-list');
    const mine = new Set(installed.map((p) => p.name));
    const extra = serverOnly.filter((p) => !mine.has(p.name)).map(serverCard);
    list.replaceChildren(...(installed.length || extra.length ? [...installed.map(card), ...extra] : [el('li', { className: 'empty', textContent: '还没有安装技能。从下方推荐里一键安装，或粘贴 GitHub 地址。' })]));
    bulk.apply();
    renderRecommend();
    onChange?.(installed);
  }

  // 任何地方装 / 卸 / 同步了技能（对话里、推荐列表、另一台设备）都自动刷新
  let pending = 0;
  addEventListener('jarvis:skills-changed', () => { clearTimeout(pending); pending = setTimeout(refresh, 50); });

  function card(p) {
    const compatibility = skillCompatibility(p, { mobile: MOBILE });
    const builtinTitle = [...BUILTIN_SKILLS, ...MORE_BUILTIN_SKILLS].find(s => parseFrontmatter(s.text).meta.name === p.name)?.title;
    const toggle = el('input', { type: 'checkbox', checked: p.enabled, title: p.enabled ? '停用' : '启用' });
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      toggle.disabled = true;
      try {
        const c = server();
        if (c) {
          if (!c.setSkillEnabled) throw new Error('请先更新服务器后再修改技能启停');
          await c.setSkillEnabled(p.name, enabled);
        }
        await packs.setEnabled(p.name, enabled);
        await refresh();
      } catch (error) {
        toggle.checked = p.enabled;
        toast(`技能启停没有保存：${error.message}`);
      } finally {
        toggle.disabled = false;
      }
    });
    const view = el('button', { type: 'button', className: 'btn ghost sm', textContent: '查看' });
    view.addEventListener('click', () => show(p));
    const use = el('button', { type: 'button', className: 'btn ghost sm', textContent: '使用', disabled: !p.enabled || compatibility.status === 'blocked' });
    use.addEventListener('click', () => onUse(p.name));
    const del = el('button', { type: 'button', className: 'btn ghost sm danger', textContent: '卸载' });
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '确认卸载'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = '卸载'; }, 3000); return; }
      await removeSkills([p.name]);
    });
    const files = Object.keys(p.files || {}).length;
    return bulk.decorate(el('li', { className: `skill${p.enabled ? '' : ' off'}` },
      el('strong', { className: 'wb-skill-title', textContent: builtinTitle || p.name }),
      el('div', { className: 'skill-top' },
        el('label', { className: 'switch', title: '启用 / 停用' }, toggle, el('span')),
        el('code', { className: 'skill-name', textContent: `/${p.name}` }),
        el('span', { className: 'skill-src', textContent: p.source, title: p.source })),
      el('p', { className: 'skill-desc', textContent: p.description || '（没有描述）' }),
      MOBILE ? badge(compatibility) : null,
      el('div', { className: 'skill-actions' },
        el('span', { className: 'muted small', textContent: files ? `附带 ${files} 个文件` : '' }), view, use, del)), p, builtinTitle);
  }

  /** 只在服务器上的技能：本机没有内容，只能看说明、删除 */
  function serverCard(p) {
    const del = el('button', { type: 'button', className: 'btn ghost sm danger', textContent: '卸载' });
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '确认卸载'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = '卸载'; }, 3000); return; }
      await removeSkills([p.name]);
    });
    return bulk.decorate(el('li', { className: `skill server-only${p.enabled ? '' : ' off'}` },
      el('strong', { className: 'wb-skill-title', textContent: p.name }),
      el('div', { className: 'skill-top' },
        el('code', { className: 'skill-name', textContent: `/${p.name}` }),
        el('span', { className: 'skill-src', textContent: `只在服务器上 · ${p.source || ''}`, title: p.source || '' })),
      el('p', { className: 'skill-desc', textContent: p.description || '（没有描述）' }),
      el('div', { className: 'skill-actions' }, el('span', { className: 'muted small', textContent: '在对话里让未央装的，任务在服务器上能用' }), del)), { ...p, source: `服务器 ${p.source || ''}` });
  }

  const missing = (p) => Object.entries(p.files || {}).filter(([, f]) => f?.stub).map(([k]) => k);
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
      p.skipped?.length ? el('div', { className: 'muted small' }, `没装上的 ${p.skipped.length} 个文件：${p.skipped.slice(0, 40).join('、')}${p.skipped.length > 40 ? ' …' : ''}`) : null,
      missing(p).length ? el('div', { className: 'muted small' }, `这台设备上缺 ${missing(p).length} 个附件（同步时不传大附件）：重新安装一次这个技能即可补齐`) : null
    ].filter(Boolean));
    v.hidden = false;
    v.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function badge(c) { const b = el('span', { className: 'skill-compat', textContent: `${c.label} · ${c.reason}` }); b.dataset.status = c.status; return b; }
  function renderRecommend() {
    const have = new Set(installed.map((p) => p.name));
    const builtin = [...BUILTIN_SKILLS, ...MORE_BUILTIN_SKILLS].map((s) => {
      const { meta } = parseFrontmatter(s.text);
      return tile({ title: s.title, name: meta.name, desc: meta.description.replace(/。.*$/, '。'), pack: { meta, body: parseFrontmatter(s.text).body }, tag: '内置', installed: have.has(meta.name), install: () => packs.installFromText(s.text, '内置') });
    });
    const gh = GITHUB_SKILLS.map((s) => tile({ title: s.title, name: s.name, desc: s.desc, pack: { unverified:true, name: s.name, description: s.desc, body: s.desc }, tag: 'GitHub', installed: have.has(s.name), install: () => fromGitHub(s.url) }));
    $('#skill-recommend').replaceChildren(...builtin, ...gh);
  }

  function tile({ title, name, desc, tag, pack, installed: on, install }) {
    const c = skillCompatibility(pack, { mobile: MOBILE });
    const btn = el('button', { type: 'button', className: `btn sm${on ? ' ghost' : ''}`, textContent: on ? '已安装' : MOBILE && c.status === 'blocked' ? '手机用不了' : '安装', disabled: on || MOBILE && c.status === 'blocked' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '安装中…';
      try {
        const p = await install();
        if (p) { toast(`已安装技能：${p.name}${MOBILE ? `（${skillCompatibility(p, { mobile: true }).label}）` : ''}`); await refresh(); }
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
      MOBILE ? badge(c) : null, btn);
  }

  // 服务器模式：任务在服务器上做，技能也要在服务器上。手机 / 电脑装好就传过去（服务器连 GitHub 常常很慢，在这边下好再传更稳）
  const server = () => (globalThis.__jarvisServerMode ? globalThis.__jarvisServerClient : null);
  async function pushToServer(list) {
    const c = server();
    if (!c?.installSkill) return '';
    const done = [];
    const failed = [];
    for (const p of list) {
      try {
        const r = await c.installSkill(packs.packToFiles(p), `从${MOBILE ? '手机' : '电脑'}同步（原来源：${p.source || '本地'}）`);
        done.push(r.needsRunner && !r.runner ? `${p.name}（带脚本：服务器还没装技能运行器）` : p.name);
      } catch (e) {
        failed.push(`${p.name}：${e.message}`);
      }
    }
    refreshServer();
    return `${done.length ? `；已同步到服务器：${done.join('、')}` : ''}${failed.length ? `；没传到服务器：${failed.join('；')}` : ''}`;
  }
  const serverLine = el('p', { className: 'muted small', id: 'skill-server', hidden: true });
  const syncBtn = el('button', { type: 'button', className: 'btn ghost sm', textContent: '把已装技能同步到服务器', hidden: true });
  status.after(serverLine, syncBtn);
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    status.textContent = '正在同步到服务器…';
    const mine = installed.filter((p) => p.source !== '内置');
    status.textContent = mine.length ? `同步完成${await pushToServer(mine)}` : '没有要同步的技能（内置技能服务器上本来就有）';
    syncBtn.disabled = false;
  });
  async function refreshServer() {
    const c = server();
    serverLine.hidden = syncBtn.hidden = !c?.listSkills;
    if (!c?.listSkills) return;
    try {
      const r = await c.listSkills();
      const before = serverOnly.map((p) => p.name).join();
      serverOnly = r.skills.filter((p) => !p.builtin);
      if (serverOnly.map((p) => p.name).join() !== before) refresh();
      const scripts = r.skills.filter((p) => p.needsRunner && !p.builtin).length;
      serverLine.textContent = `服务器上有 ${r.skills.length} 个技能；技能运行器（运行技能里的 Python / Node 脚本）：${r.runner.available ? '已装好' : '还没装（带脚本的技能只能读说明，装法见部署说明“技能运行器”一节）'}${scripts ? `；带脚本的技能 ${scripts} 个` : ''}`;
    } catch {
      serverLine.textContent = '服务器版本太旧，不能同步技能：请先在设置里“立即更新服务器”';
    }
  }
  refreshServer();
  // 打开“技能”页时再问一次服务器：对话里刚让未央装的技能也能马上看到
  const pane = document.querySelector('[data-pane=skills]');
  if (pane) new MutationObserver(() => { if (!pane.hidden) refreshServer(); }).observe(pane, { attributes: true, attributeFilter: ['hidden'] });

  async function fromGitHub(url) {
    status.textContent = '正在连接 GitHub…';
    try {
      const p = await packs.installFromGitHub(url, { onProgress: (m) => { status.textContent = m; } });
      const names = [p, ...(p.also || [])].map((x) => `「${x.name}」`).join('');
      const all = [p, ...(p.also || [])];
      const files = all.reduce((n, x) => n + Object.keys(x.files || {}).length, 0);
      const skipped = all.flatMap((x) => x.skipped);
      status.textContent = `已安装${names}，共 ${files + all.length} 个文件${skipped.length ? `；${skipped.length} 个没装上：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? ' …（点“查看”看全部）' : ''}` : ''}`;
      if (server()) status.textContent += await pushToServer(all);
      await refresh();
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
      toast(p.also?.length ? `已安装 ${p.also.length + 1} 个技能` : `已安装技能：${p.name}`);
      $('#skill-url').value = '';
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
      status.textContent = `已安装「${p.name}」${p.skipped.length ? `（${p.skipped.length} 个文件没装上：${p.skipped.slice(0, 5).join('、')}${p.skipped.length > 5 ? ' …' : ''}）` : ''}`;
      if (server()) status.textContent += await pushToServer([p]);
      toast(`已安装技能：${p.name}${MOBILE ? `（${skillCompatibility(p, { mobile: true }).label}）` : ''}`);
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
    const on = installed.filter((p) => p.enabled && skillCompatibility(p, { mobile: MOBILE }).status !== 'blocked');
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

  // 首次启动：预置常用技能
  // 手机首屏小，这条提示会正好盖住首页的任务卡；手机上不弹（技能在左边栏“技能”里能看到，输入 / 也会列出来）
  packs.seedBuiltins().then((added) => { if (added.length && !MOBILE) toast(`已预置 ${added.length} 个常用技能，输入 / 可以点名使用`); }).catch(() => {}).finally(refresh);
  return { refresh, installFile, get installed() { return installed; } };
}
