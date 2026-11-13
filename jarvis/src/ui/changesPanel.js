/**
 * 工作区 →“改动记录”：未央改过的文件，按时间列出，每条可以一键恢复。
 *   工作区（浏览器内）：src/agent/fileHistory.js
 *   电脑上的文件（只有桌面版）：desktop/backups.mjs，通过 jarvisDesktop.invoke 调用
 * 恢复前先检查；有要提醒的（比如之后又被改过）就在这一行里展开确认，不用系统弹窗。
 */
import * as ws from '../agent/workspace.js';
import * as fileHistory from '../agent/fileHistory.js';
import { fmtSize } from '../agent/tools.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
};
const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const ACTION = { overwrite: '恢复', delete: '恢复', create: '撤销', copy: '撤销', move: '移回' };
const DONE = { overwrite: '已恢复', delete: '已恢复', create: '已撤销', copy: '已撤销', move: '已移回' };

/** 两边的记录合并成一个列表（新的在前） */
export async function loadChanges(desktop = null) {
  const local = (await fileHistory.list().catch(() => [])).map((e) => ({ ...e, where: 'workspace' }));
  const pc = desktop ? (await desktop.invoke('backupList').catch(() => [])).map((e) => ({ ...e, where: 'computer' })) : [];
  return [...local, ...pc].sort((a, b) => b.ts - a.ts);
}

/**
 * @param {{ toast: (t: string) => void, desktop?: { invoke: Function } | null, onRestored?: (e: object) => void }} o
 */
export function initChangesPanel({ toast, desktop = null, onRestored = () => {} }) {
  const check = (e) => (e.where === 'computer' ? desktop.invoke('backupCheck', { id: e.id }) : ws.checkVersion(e.id));
  const restore = (e) => (e.where === 'computer' ? desktop.invoke('backupRestore', { id: e.id }) : ws.restoreVersion(e.id));

  async function refresh() {
    const list = $('#change-list');
    $('#change-hint').textContent = desktop
      ? '未央覆盖、移动、删除文件之前会自动留一份，在这里可以恢复。保留 30 天；电脑上的文件最多占 500 MB，工作区最多 100 MB。'
      : `未央覆盖同名文件、你手动删除文件之前会自动留一份，在这里可以恢复。保留 30 天，最多占 100 MB。${ws.mode() === 'folder' ? '下面是浏览器内工作区的记录；连接的本地文件夹里，未央不会覆盖或删除文件。' : ''}`;
    const items = await loadChanges(desktop);
    list.replaceChildren(...(items.length ? items.map(row) : [el('li', { className: 'empty', textContent: '还没有改动记录。未央覆盖、删除文件后，会在这里留下可以恢复的版本。' })]));
  }

  function row(e) {
    const li = el('li', { className: 'change' });
    const target = e.op === 'move' ? `${e.path} → ${e.to}` : e.path;
    const info = el('span', { className: 'fn', textContent: target, title: [target, e.note].filter(Boolean).join('\n') });
    const sizeText = e.stored ? fmtSize(e.size) : (e.op === 'overwrite' || e.op === 'delete') ? '太大，未备份' : '';
    const head = el('div', { className: 'change-head' },
      el('span', { className: 'fs', textContent: when(e.ts) }),
      el('span', { className: `tag op-${e.op}`, textContent: e.opName }),
      desktop ? el('span', { className: 'tag where', textContent: e.where === 'computer' ? '电脑' : '工作区' }) : null,
      info,
      sizeText ? el('span', { className: 'fs', textContent: sizeText }) : null);
    const btn = el('button', { type: 'button', className: 'btn ghost sm', textContent: ACTION[e.op] ?? '恢复' });
    if (e.restoredAt) head.append(el('span', { className: 'fs done', textContent: DONE[e.op] ?? '已恢复', title: `${when(e.restoredAt)} ${DONE[e.op] ?? '已恢复'}` }));
    head.append(btn);
    li.append(head);
    if (e.note) li.append(el('div', { className: 'change-note muted small', textContent: e.note }));

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const c = await check(e);
        if (!c.ok) { toast(c.problem); btn.disabled = false; return; }
        // 在这一行里展开确认
        const what = { overwrite: `把 ${e.path} 恢复成 ${when(e.ts)} 被覆盖之前的内容`, delete: `把 ${e.path} 恢复到原位置`, create: `删掉未央新建的 ${e.path}`, copy: `删掉复制出来的 ${e.path}`, move: `把 ${e.to} 移回 ${e.path}` }[e.op];
        const extra = e.where === 'computer' && (e.op === 'create' || e.op === 'copy') ? '（移到回收站）' : '';
        const yes = el('button', { type: 'button', className: 'btn sm', textContent: `确认${ACTION[e.op] ?? '恢复'}` });
        const no = el('button', { type: 'button', className: 'btn ghost sm', textContent: '取消' });
        const box = el('div', { className: `change-confirm${c.warning ? ' warn' : ''}` },
          el('div', { textContent: `将${what}${extra}。${e.op === 'move' ? '' : '当前的内容会先备份，恢复后还能再撤回。'}` }),
          c.warning ? el('div', { className: 'change-warning', textContent: `注意：${c.warning}` }) : null,
          el('div', { className: 'change-actions' }, yes, no));
        li.append(box);
        no.addEventListener('click', () => { box.remove(); btn.disabled = false; });
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          no.disabled = true;
          try {
            await restore(e);
            toast(`${DONE[e.op] ?? '已恢复'}：${e.op === 'move' ? e.path : e.path.split(/[\\/]/).pop()}`);
            onRestored(e);
          } catch (err) {
            toast(`没有${ACTION[e.op] ?? '恢复'}：${err.message}`);
          }
          refresh();
        });
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
    return li;
  }

  return { refresh };
}
