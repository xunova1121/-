/**
 * “对话”面板：历史对话按天分组；搜索标题与内容；打开、重命名、钉住、导出 Markdown、删除。
 */
import * as sessions from '../agent/sessions.js';
import { saveFile } from './saveFile.js';
import { groupByDay } from '../core/memoryStore.js';
import { loadHistory, sessionListRow } from './historyList.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
function displayTime(format, value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format.format(date) : '';
}

/**
 * @param {{ getCurrentId: () => string, onOpen: (id: string) => void, onNew: () => void, onDeleted: (id: string) => void, settings: object, onSaveChange: (on: boolean) => void }} o
 */
export function initSessionsPanel({ getCurrentId, onOpen, onNew, onDeleted, settings, onSaveChange, onExport, isVisible = () => true, pageSize = Infinity, source = () => null }) {
  let query = '';
  let timer = 0;
  let revision = 0;
  let page = 0;
  let scope = source();
  const box = $('#session-list');
  const trashBox = $('#session-trash-list');
  const trash = $('#session-trash');
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  let trashItems = [];

  /** 回收站：删掉的对话，7 天内能恢复 */
  function renderTrash() {
    if (!trash.open || !isVisible()) { trashBox.replaceChildren(); return; }
    trashBox.replaceChildren(...(trashItems.length ? trashItems.map((x) => {
      const back = el('button', { type: 'button', className: 'x-btn', textContent: '恢复', title: '恢复这段对话' });
      back.addEventListener('click', async () => { back.disabled = true; await sessions.restore(x.id).catch(() => null); refresh(); });
      return el('div', { className: 'session' },
        el('div', { className: 'session-main' }, el('span', { className: 'session-title', textContent: x.title }), el('span', { className: 'session-snippet', textContent: `${x.count} 条 · ${displayTime(day, x.trashedAt)} 删除 · ${displayTime(day, x.expiresAt)} 后彻底删除` })),
        el('div', { className: 'session-actions' }, back));
    }) : [el('p', { className: 'empty', textContent: '回收站是空的。' })]));
  }

  let lastShown = null;
  function release() {
    revision++;
    clearTimeout(timer);
    page = 0;
    trashItems = [];
    box.replaceChildren();
    trashBox.replaceChildren();
  }
  async function refresh() {
    if (!isVisible()) return;
    if (scope !== source()) {
      release();
      scope = source();
      lastShown = null;
    }
    const mine = ++revision;
    const current = () => mine === revision && scope === source() && isVisible();
    sessions.listTrash().catch(() => []).then(items => {
      if (!current()) return;
      trashItems = items;
      $('#session-trash-count').textContent = items.length ? `（${items.length}）` : '';
      renderTrash();
    });
    // 读不到时用上次的列表并提示，不显示成“还没有保存的对话”（2026-11-18 用户：对话全没了）
    const got = await loadHistory({ list: () => sessions.search(query), cached: () => (query ? null : sessions.cachedList?.()), shown: () => (query ? null : lastShown) });
    if (!current()) return;
    const list = (got.rows || []).map(sessionListRow);
    const total = query ? await sessions.list().then((r) => r.length).catch(() => list.length) : list.length;
    if (!current()) return;
    if (!query && !got.stale && got.rows) lastShown = list;
    $('#session-count').textContent = `${total} 段`;
    $('#set-save-sessions').checked = settings.saveSessions !== false;
    if (!got.rows) { box.replaceChildren(el('p', { className: 'empty', textContent: got.hint })); return; }
    if (!list.length) {
      box.replaceChildren(el('p', { className: 'empty', textContent: query ? '没有找到匹配的对话。' : '还没有保存的对话。开始聊天后会自动出现在这里。' }));
      return;
    }
    drawPage([...list.filter(s => s.pinned), ...list.filter(s => !s.pinned)], got.stale ? got.hint : '');
  }

  function drawPage(ordered, hint) {
    const pages = Number.isFinite(pageSize) ? Math.ceil(ordered.length / pageSize) : 1;
    page = Math.min(page, pages - 1);
    const visible = pages === 1 ? ordered : ordered.slice(page * pageSize, (page + 1) * pageSize);
    const pinned = visible.filter(s => s.pinned);
    const rest = visible.filter(s => !s.pinned);
    const groups = [
      ...(pinned.length ? [{ key: 'pinned', label: '已钉住', items: pinned }] : []),
      ...groupByDay(rest.map((s) => ({ ...s, ts: s.updatedAt })))
    ];
    box.replaceChildren(...(hint ? [el('p', { className: 'empty', textContent: hint })] : []), ...groups.map((g) => el('section', { className: 'session-group' },
      el('h4', { textContent: g.label }),
      ...g.items.map(row))));
    if (pages > 1) {
      function go(label, offset) {
        const b = el('button', { type: 'button', className: 'btn ghost sm', textContent: label, disabled: page + offset < 0 || page + offset >= pages });
        b.onclick = () => {
          page += offset;
          drawPage(ordered, hint);
          box.scrollIntoView({ block: 'start' });
          box.querySelector('.session')?.focus({ preventScroll: true });
        };
        return b;
      }
      box.append(el('nav', { className: 'row', ariaLabel: '历史对话翻页' }, go('上一页', -1), el('span', { textContent: `${page + 1} / ${pages}` }), go('下一页', 1)));
    }
  }

  function row(s) {
    const cur = s.id === getCurrentId();
    const title = el('span', { className: 'session-title', textContent: s.title });
    const meta = el('span', { className: 'session-meta', textContent: `${displayTime(time, s.updatedAt)} · ${s.count} 条` });
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
          : btn('⇩', '导出为 Markdown', async () => {
              const full = await sessions.get(s.id) || sessions.cachedGet(s.id);
              if (full) saveFile(new Blob([sessions.toMarkdown(full)], { type: 'text/markdown' }), `${s.title}.md`);
            }),
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
    query = e.target.value;
    revision++;
    page = 0;
    timer = setTimeout(refresh, 150);
  });
  trash.addEventListener('toggle', renderTrash);
  $('#set-save-sessions').addEventListener('change', (e) => onSaveChange(e.target.checked));
  refresh();
  return { refresh, release };
}
