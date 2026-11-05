/** 个人智能体编辑器：复用已有注册表，保存失败留住表单；关闭不保存。 */
import { studioEl as el } from './agentStudio.js';

export function createAgentProfileEditor({ onSave, onRemove }) {
  const back = el('button', { type: 'button', className: 'wy-agents-back', textContent: '‹', ariaLabel: '返回' });
  const title = el('h2', { textContent: '创建智能体' });
  const body = el('form', { className: 'wy-studio-editor-body' });
  const notice = el('p', { className: 'wy-studio-editor-status', role: 'status', ariaLive: 'polite' });
  const root = el('section', { className: 'wy-agents wy-studio-editor', hidden: true, ariaLabel: '编辑个人智能体' },
    el('header', { className: 'wy-agents-bar' }, back, title), body);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  document.body.append(root);
  let profile = null;
  let token = null;
  let after = () => {};
  let revision = 0;
  let busy = false;
  const fields = new Map();

  function field(key, label, value, max, area = false) {
    const input = el(area ? 'textarea' : 'input', { value, maxLength: max, required: true, className: 'wy-studio-text' });
    input.setAttribute('aria-label', label);
    fields.set(key, input);
    return el('label', { className: 'wy-studio-editor-field' }, el('span', { textContent: label }), input);
  }
  function close() { ++revision; root.hidden = true; body.replaceChildren(); fields.clear(); }
  back.addEventListener('click', close);
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const nodes = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  function pending(value) {
    busy = value;
    for (const node of body.querySelectorAll('button, input, textarea')) node.disabled = value;
  }
  body.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy || !body.reportValidity()) return;
    const mine = revision;
    const value = Object.fromEntries([...fields].map(([key, node]) => [key, node.value.trim()]));
    pending(true);
    notice.textContent = '正在保存…';
    try {
      await onSave(profile, value, token);
      if (mine !== revision) return;
      close();
      after();
    } catch (err) {
      if (mine === revision) notice.textContent = err?.message || '保存失败，请重试。';
    } finally { if (mine === revision) pending(false); }
  });
  function open(value, context, done) {
    ++revision;
    busy = false;
    profile = value;
    token = context;
    after = done;
    fields.clear();
    notice.textContent = '';
    title.textContent = value ? '编辑智能体' : '创建智能体';
    body.replaceChildren(el('h3', { textContent: '按你的方式，安排工作。' }),
      el('p', { className: 'wy-agent-start-note', textContent: '写下角色、工作步骤和交付要求。保存后从广场开启对话。' }),
      field('name', '名称', value?.name || '', 40),
      field('intro', '一句话介绍', value?.intro || '', 200),
      field('prompt', '工作要求与步骤（最多600字）', value?.prompt || '', 600, true),
      ...Array.from({ length: 3 }, (_, i) => field(`starter${i}`, `推荐问题 ${i + 1}`, value?.starters[i] || '', 200)),
      notice, el('button', { type: 'submit', className: 'wy-studio-save', textContent: '保存智能体' }));
    // 原配置可以有空角色提示，其余必填项仍由统一校验检查。
    fields.get('prompt').required = false;
    if (value && onRemove) {
      const remove = el('button', { type: 'button', className: 'wy-studio-remove', textContent: '删除智能体' });
      let confirm = false;
      remove.addEventListener('click', async () => {
        if (!confirm) { confirm = true; remove.textContent = '确认删除（已有对话保留）'; return; }
        const mine = revision;
        pending(true);
        try {
          await onRemove(value, token);
          if (mine !== revision) return;
          close(); after();
        } catch (err) { if (mine === revision) notice.textContent = err?.message || '删除失败，请重试。'; }
        finally { if (mine === revision) pending(false); }
      });
      body.append(remove);
    }
    root.hidden = false;
    requestAnimationFrame(() => back.focus());
  }
  return { root, open, close };
}
