/**
 * “定时任务”面板：列表（下一次时间、上次结果、启停、立即运行、查看结果、删除）与新建表单。
 */
import * as scheduler from '../agent/scheduler.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/**
 * @param {{ toast: (t: string) => void, runNow: (s: object) => Promise<void>, openSession: (id: string) => void }} o
 */
export function initSchedulesPanel({ toast, runNow, openSession }) {
  const form = $('#sched-form');
  const f = form.elements;

  async function refresh() {
    const list = await scheduler.list().catch(() => []);
    $('#sched-count').textContent = `${list.filter((s) => s.enabled).length} 个启用`;
    $('#sched-list').replaceChildren(...(list.length ? list.map(card) : [el('li', { className: 'empty', textContent: '还没有定时任务。可以在下面新建，或者直接对贾维斯说“每个工作日早上 9 点帮我……”。' })]));
  }

  function card(s) {
    const toggle = el('input', { type: 'checkbox', checked: s.enabled, title: s.enabled ? '停用' : '启用' });
    toggle.addEventListener('change', async () => { await scheduler.setEnabled(s.id, toggle.checked); refresh(); });
    const btn = (text, fn, cls = '') => { const b = el('button', { type: 'button', className: `btn ghost sm ${cls}`, textContent: text }); b.addEventListener('click', () => fn(b)); return b; };
    const status = s.lastStatus === 'ok' ? '上次成功' : s.lastStatus === 'quiet' ? '已检查，无需通知' : s.lastStatus ? s.lastStatus : '还没运行过';
    const bad = s.lastStatus && s.lastStatus !== 'ok' && s.lastStatus !== 'quiet';
    return el('li', { className: `skill sched${s.enabled ? '' : ' off'}` },
      el('div', { className: 'skill-top' },
        el('label', { className: 'switch', title: '启用 / 停用' }, toggle, el('span')),
        el('strong', { textContent: s.title }),
        el('span', { className: 'sched-when-tag', textContent: scheduler.describe(s) })),
      el('p', { className: 'skill-desc', textContent: s.prompt }),
      el('div', { className: 'sched-meta' },
        el('span', { textContent: `下一次：${s.enabled ? fmt(s.nextRun) : '—'}` }),
        el('span', { className: bad ? 'bad' : '', textContent: `${status}${s.lastRun ? `（${fmt(s.lastRun)}）` : ''} · 共 ${s.runs ?? 0} 次` }),
        s.unattended ? el('span', { className: 'warn', textContent: '允许无人值守操作' }) : null),
      el('div', { className: 'skill-actions' },
        el('span', { className: 'muted small' }),
        s.lastSession ? btn('查看结果', () => openSession(s.lastSession)) : null,
        btn('立即运行', async (b) => { b.disabled = true; b.textContent = '运行中…'; try { await runNow(s); } finally { refresh(); } }),
        btn('删除', async (b) => {
          if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = '确认删除'; setTimeout(() => { b.dataset.c = ''; b.textContent = '删除'; }, 3000); return; }
          await scheduler.remove(s.id);
          refresh();
        }, 'danger')));
  }

  function syncKind() {
    const k = f.kind.value;
    for (const f of form.querySelectorAll('[data-k]')) f.hidden = !f.dataset.k.split(' ').includes(k);
  }
  f.kind.addEventListener('change', syncKind);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = f.kind.value;
    try {
      const s = await scheduler.upsert({
        title: f.title.value,
        prompt: f.prompt.value,
        kind: k,
        time: f.time.value || '09:00',
        weekday: Number(f.weekday.value),
        at: k === 'once' ? new Date(f.at.value).getTime() : undefined,
        everyMinutes: Math.max(5, Number(f.every.value) || 60),
        unattended: f.unattended.checked
      });
      $('#sched-status').textContent = `已添加，下一次：${fmt(s.nextRun)}`;
      form.reset();
      syncKind();
      // 网页版：请求通知权限，到点时能弹出系统通知
      if (!window.jarvisDesktop && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      refresh();
    } catch (err) {
      $('#sched-status').textContent = err.message;
    }
  });
  syncKind();
  refresh();
  return { refresh };
}
