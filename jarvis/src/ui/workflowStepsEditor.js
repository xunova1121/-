/**
 * 个人智能体的工作流步骤编辑（编排层界面）：竖向步骤列表，每步写“做什么”、交给哪个智能体、做完怎么检查；
 * 可上移 / 下移 / 删除，最多 8 步。不做拖拽连线画布（手机上不好用）。只产出数据，保存由 agentProfileActions 统一校验。
 */
import { studioEl as el } from './agentStudio.js';
import { BUILTIN_AGENTS } from '../agent/agentProfiles.js';
import { MAX_WORKFLOW_STEPS } from '../agent/agentProfileValidation.js';
import { WORKFLOW_PRESETS } from '../agent/workflowPresets.js';

const CHECKS = [['none', '不检查'], ['gongwen', '公文体检'], ['numbers', '数字前后一致']];

export function createStepsEditor(initial = []) {
  const list = el('ol', { className: 'wy-flow-steps' });
  const add = el('button', { type: 'button', className: 'wy-flow-add', textContent: '＋ 添加一步' });
  // 现成的工作流：选了就把步骤换成模板里的（已写的步骤会被替换）
  const preset = el('select', { className: 'wy-agent-select wy-flow-preset' }, el('option', { value: '', textContent: '从现成的工作流开始（可选）' }), ...WORKFLOW_PRESETS.map((p) => el('option', { value: p.id, textContent: p.name })));
  preset.setAttribute('aria-label', '套用现成的工作流');
  const root = el('section', { className: 'wy-flow' },
    el('h3', { textContent: '工作步骤（可选）' }),
    el('p', { className: 'wy-agent-start-note', textContent: '写了步骤，发消息后会按顺序一步步做：每步可以交给不同的智能体，做完可自动检查，不合格会改一次。不写就按上面的要求直接做。' }),
    preset, list, add);

  function row(step = {}) {
    const title = el('input', { className: 'wy-studio-text', value: step.title || '', maxLength: 40, placeholder: '这一步叫什么，如：起草' });
    title.setAttribute('aria-label', '步骤名称');
    const task = el('textarea', { className: 'wy-studio-text', value: step.task || '', maxLength: 600, placeholder: '这一步要做什么，如：根据用户给的要点起草请示' });
    task.setAttribute('aria-label', '这一步要做什么');
    const agent = el('select', { className: 'wy-agent-select' }, el('option', { value: '', textContent: '用这个智能体自己' }), ...BUILTIN_AGENTS.map((p) => el('option', { value: p.id, textContent: `交给：${p.name}` })));
    agent.value = step.agentId || '';
    agent.setAttribute('aria-label', '交给哪个智能体');
    const check = el('select', { className: 'wy-agent-select' }, ...CHECKS.map(([v, t]) => el('option', { value: v, textContent: `做完：${t}` })));
    check.value = step.check || 'none';
    check.setAttribute('aria-label', '做完怎么检查');
    const onlyIf = el('input', { className: 'wy-studio-text', value: step.onlyIf || '', maxLength: 40, placeholder: '仅当上一步结果包含这句话才做（可选）' });
    onlyIf.setAttribute('aria-label', '执行条件');
    const review = el('input', { type: 'checkbox', checked: step.review === true, ariaLabel: '此步完成后等待确认' });
    const up = el('button', { type: 'button', className: 'wy-flow-move', textContent: '↑', ariaLabel: '上移' });
    const down = el('button', { type: 'button', className: 'wy-flow-move', textContent: '↓', ariaLabel: '下移' });
    const del = el('button', { type: 'button', className: 'wy-flow-move', textContent: '×', ariaLabel: '删除这一步' });
    const li = el('li', { className: 'wy-flow-step' }, el('div', { className: 'wy-flow-row' }, title, up, down, del), task, el('div', { className: 'wy-flow-row' }, agent, check), onlyIf);
    li.append(el('label', { className: 'wy-library-field' }, review, document.createTextNode('此步完成后等待我确认')));
    li.read = () => ({ title: title.value.trim(), task: task.value.trim(), agentId: agent.value, check: check.value, onlyIf: onlyIf.value.trim(), review: review.checked });
    up.addEventListener('click', () => { if (li.previousElementSibling) list.insertBefore(li, li.previousElementSibling); refresh(); });
    down.addEventListener('click', () => { if (li.nextElementSibling) list.insertBefore(li.nextElementSibling, li); refresh(); });
    del.addEventListener('click', () => { li.remove(); refresh(); });
    return li;
  }
  function refresh() {
    const rows = [...list.children];
    rows.forEach((li, i) => {
      const [up, down] = li.querySelectorAll('.wy-flow-move');
      up.disabled = i === 0;
      down.disabled = i === rows.length - 1;
    });
    add.disabled = rows.length >= MAX_WORKFLOW_STEPS;
  }
  preset.addEventListener('change', () => {
    const p = WORKFLOW_PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    list.replaceChildren(...p.steps.map((step) => row(step)));
    refresh();
  });
  add.addEventListener('click', () => { list.append(row()); refresh(); list.lastElementChild?.querySelector('input')?.focus(); });
  for (const step of initial) list.append(row(step));
  refresh();

  /** 读出步骤：标题和内容都空的一行忽略；只填了一半的交给统一校验报出具体是第几步 */
  const value = () => [...list.children].map((li) => li.read()).filter((s) => s.title || s.task).map((s) => ({ title: s.title, task: s.task, ...(s.agentId && { agentId: s.agentId }), ...(s.check !== 'none' && { check: s.check }), ...(s.onlyIf && { onlyIf: s.onlyIf }), ...(s.review && { review: true }) }));
  return { root, value };
}
