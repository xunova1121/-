/**
 * “对话”面板：历史对话按天分组；搜索标题与内容；打开、重命名、钉住、导出 Markdown、删除。
 */
import * as sessions from '../agent/sessions.js';
import { saveFile } from './saveFile.js';
import { groupByDay } from '../core/memoryStore.js';
import { loadHistory } from './historyList.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

/**
 * @param {{ getCurrentId: () => string, onOpen: (id: string) => void, onNew: () => void, onDeleted: (id: string) => void, settings: object, onSaveChange: (on: boolean) => void }} o
 */
export function initSessionsPanel({ getCurrentId, onOpen, onNew, onDeleted, settings, onSaveChange, onExport }) {
  let query = '';
  let timer = 0;

  /** 回收站：删掉的对话，7 天内能恢复 */
  async function refreshTrash() {
    const items = await sessions.listTrash().catch(() => []);
    $('#session-trash-count').textContent = items.length ? `（${items.length}）` : '';
    const day = (t) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    $('#session-trash-list').replaceChildren(...(items.length ? items.map((x) => {
      const back = el('button', { type: 'button', className: 'x-btn', textContent: '恢复', title: '恢复这段对话' });
      back.addEventListener('click', async () => { back.disabled = true; await sessions.restore(x.id).catch(() => null); refresh(); });
      return el('div', { className: 'session' },
        el('div', { className: 'session-main' }, el('span', { className: 'session-title', textContent: x.title }), el('span', { className: 'session-snippet', textContent: `${x.count} 条 · ${day(x.trashedAt)} 删除 · ${day(x.expiresAt)} 后彻底删除` })),
        el('div', { className: 'session-actions' }, back));
    }) : [el('p', { className: 'empty', textContent: '回收站是空的。' })]));
  }

  let lastShown = null;
  async function refresh() {
    refreshTrash();
    // 读不到时用上次的列表并提示，不显示成“还没有保存的对话”（2026-11-18 用户：对话全没了）
    const got = await loadHistory({ list: () => sessions.search(query), cached: () => (query ? null : sessions.cachedList?.()), shown: () => (query ? null : lastShown) });
    const list = got.rows || [];
    if (!query && !got.stale && got.rows) lastShown = list;
    const total = query ? await sessions.list().then((r) => r.length).catch(() => list.length) : list.length;
    $('#session-count').textContent = `${total} 段`;
    $('#set-save-sessions').checked = settings.saveSessions !== false;
    const box = $('#session-list');
    if (!got.rows) { box.replaceChildren(el('p', { className: 'empty', textContent: got.hint })); return; }
    if (!list.length) {
      box.replaceChildren(el('p', { className: 'empty', textContent: query ? '没有找到匹配的对话。' : '还没有保存的对话。开始聊天后会自动出现在这里。' }));
      return;
    }
    const pinned = list.filter((s) => s.pinned);
    const rest = list.filter((s) => !s.pinned);
    const groups = [
      ...(pinned.length ? [{ key: 'pinned', label: '已钉住', items: pinned }] : []),
      ...groupByDay(rest.map((s) => ({ ...s, ts: s.updatedAt })))
    ];
    box.replaceChildren(...(got.stale ? [el('p', { className: 'empty', textContent: got.hint })] : []), ...groups.map((g) => el('section', { className: 'session-group' },
      el('h4', { textContent: g.label }),
      ...g.items.map(row))));
  }

  function row(s) {
    const cur = s.id === getCurrentId();
    const title = el('span', { className: 'session-title', textContent: s.title });
    const meta = el('span', { className: 'session-meta', textContent: `${new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} · ${s.messages.length} 条` });
    const btn = (text, label, fn, cls = '') => {
      const b = el('button', { type: 'button', className: `x-btn ${cls}`, title: label, textContent: text });
      b.setAttribute('aria-label', label);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
      return b;
    };
    const item = el('div', { className: `session${cur ? ' current' : ''}`, tabIndex: 0, role: 'button' },
      el('div', { className: 'session-main' }, title, s.snippet ? el('span', { className: 'session-snippet', textContent: s.snippet }) : null),
      meta,
      el('div', { className: 'session-actions' },
        btn(s.pinned ? '★' : '☆', s.pinned ? '取消钉住' : '钉住', async () => { await sessions.setPinned(s.id, !s.pinned); refresh(); }, s.pinned ? 'on' : ''),
        btn('✎', '重命名', () => {
          const input = el('input', { className: 'mem-edit', value: s.title });
          title.replaceWith(input);
          input.focus();
          input.select();
          const done = async () => { await sessions.rename(s.id, input.value); refresh(); };
          input.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') refresh(); });
          input.addEventListener('blur', done);
        }),
        // 2026-11-17 用户：电脑上找不到导出——以前只有悬停才出现的“⇩”且只能存Markdown到浏览器下载。
        // 改为写字的“导出”按钮，与手机同一流程：Word / Markdown 存进工作区“导出”文件夹并打开，或复制全文。
        onExport
          ? btn('导出', '导出这段对话', (b) => {
              const old = b.parentElement.querySelector('.session-export');
              if (old) return old.remove();
              const pick = (kind) => { menu.remove(); onExport(s.id, kind); };
              const menu = el('div', { className: 'session-export', role: 'menu' },
                ...[['docx', '导出为 Word'], ['md', '导出为 Markdown'], ['copy', '复制全部内容']].map(([kind, label]) => {
                  const item = el('button', { type: 'button', className: 'x-btn', textContent: label, role: 'menuitem' });
                  item.addEventListener('click', (e) => { e.stopPropagation(); pick(kind); });
                  return item;
                }));
              b.after(menu);
            }, 'session-export-btn')
          : btn('⇩', '导出为 Markdown', () => saveFile(new Blob([sessions.toMarkdown(s)], { type: 'text/markdown' }), `${s.title}.md`)),
        btn('✕', '删除', async (b) => {
          if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = '确认'; b.classList.add('danger'); setTimeout(() => { b.dataset.c = ''; b.textContent = '✕'; b.classList.remove('danger'); }, 3000); return; }
          // 先放回收站，7 天内能恢复（见 sessions.trash）
          await sessions.trash(s.id);
          onDeleted(s.id);
          refresh();
        })));
    const open = () => onOpen(s.id);
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return item;
  }

  $('#btn-new-session').addEventListener('click', () => onNew());
  $('#session-search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = e.target.value; refresh(); }, 150);
  });
  $('#set-save-sessions').addEventListener('change', (e) => onSaveChange(e.target.checked));
  refresh();
  return { refresh };
}
