/**
 * 对话中的轻量选择器：最上面“智能”（每句话按能力表选模型），下面常用线路，点一个就固定用它；
 * 运行位置切换沿用安全的会话重载流程。
 */
import { node } from './modelLibrary.js';
import { favoriteLines, currentLine, sameLine, providerLabel, chooseLine } from '../llm/modelLibrary.js';
import { ABILITIES, abilityLines } from '../llm/abilities.js';
import { modelKind } from '../llm/images.js';

export function initLibraryPicker({ getWorkspace, openSettings, toast }) {
  const scrim = node('div', { className: 'ml-picker-scrim', hidden: true });
  const sheet = node('section', { className: 'ml-picker', hidden: true, role: 'dialog', ariaLabel: '切换模型', tabIndex: -1 });
  sheet.setAttribute('aria-modal', 'true');
  const anchor = document.getElementById('model-chip');
  anchor?.setAttribute('aria-haspopup', 'dialog');
  anchor?.setAttribute('aria-expanded', 'false');
  document.body.append(scrim, sheet);
  let query = '';
  let notice = '';
  let ticket = 0;
  let pending = false;
  const makeButton = (text, action, className = 'ml-button') => {
    const element = node('button', { type: 'button', textContent: text, className });
    element.addEventListener('click', action);
    return element;
  };
  const operate = async (action) => {
    if (pending) return;
    pending = true;
    render();
    try {
      await action();
    } catch (error) {
      notice = error.message;
    } finally {
      pending = false;
      if (!sheet.hidden) render();
    }
  };
  function render() {
    const workspace = getWorkspace();
    if (!workspace) return;
    const runtime = workspace.runtime;
    const cfg = workspace.config(runtime);
    const head = node('header', { className: 'ml-picker-head' }, node('h2', { textContent: '切换模型' }), makeButton('×', dismiss, 'ml-dismiss'));
    head.lastElementChild.setAttribute('aria-label', '关闭模型选择');
    const tabs = node(
      'div',
      { className: 'ml-tabs' },
      ...[
        ['local', '本机'],
        ['server', '云服务器']
      ].map(([value, label]) => {
        const tab = makeButton(label, () => operate(() => workspace.switchRuntime(value)), value === runtime ? 'selected' : '');
        tab.setAttribute('aria-pressed', String(value === runtime));
        return tab;
      })
    );
    const search = node('input', { className: 'ml-picker-search', type: 'search', placeholder: '搜索常用模型', value: query, ariaLabel: '搜索常用模型' });
    const results = node('div', { className: 'ml-picker-results' });
    const pinned = Boolean(cfg?.pinModel);
    // 智能：每句话按能力表选模型（说明里列出现在各项用谁）
    const smartNote = cfg
      ? ['chat', 'code', 'vision', 'image']
          .map((ability) => {
            const line = abilityLines(cfg, ability).main;
            return line ? `${ABILITIES[ability].name.split(' ')[0]} ${line.model}` : '';
          })
          .filter(Boolean)
          .join(' · ')
      : '';
    const smart = makeButton(
      '',
      () =>
        operate(async () => {
          await workspace.patch((value) => ({ ...value, pinModel: false }), runtime);
          toast('已切到智能：每句话按能力表选模型');
          dismiss();
        }),
      `ml-picker-smart${pinned ? '' : ' selected'}`
    );
    smart.setAttribute('aria-pressed', String(!pinned));
    smart.append(
      node('span', { className: 'ml-check', textContent: pinned ? '○' : '✓' }),
      node('span', { className: 'ml-picker-model' }, node('strong', { textContent: '智能 · 按能力表选' }), node('small', { textContent: smartNote }))
    );
    const paint = () => {
      results.replaceChildren();
      if (!cfg) return;
      results.append(node('h3', { className: 'ml-picker-provider', textContent: '固定用一个模型（每句话都用它）' }));
      const lines = favoriteLines(cfg).filter(
        (line) => modelKind(line.model) === 'chat' && `${providerLabel(cfg, line.provider)} ${line.model}`.toLowerCase().includes(query.toLowerCase())
      );
      const providers = [...new Set(lines.map((line) => line.provider))];
      for (const provider of providers) {
        results.append(node('h3', { className: 'ml-picker-provider', textContent: providerLabel(cfg, provider) }));
        for (const line of lines.filter((item) => item.provider === provider)) {
          const isDefault = sameLine(currentLine(cfg), line);
          const active = pinned && isDefault;
          const row = makeButton(
            '',
            () =>
              operate(async () => {
                // 固定用它：设成默认，并且每句话都用它（不按能力表换）
                await workspace.patch((value) => ({ ...chooseLine(value, line), pinModel: true }), runtime);
                toast(`已固定用${runtime === 'server' ? '服务器' : '本机'}的 ${providerLabel(cfg, provider)} · ${line.model}；想按能力表自动选，点最上面的“智能”`);
                dismiss();
              }),
            `ml-picker-item${active ? ' selected' : ''}`
          );
          row.disabled = pending;
          row.setAttribute('aria-pressed', String(active));
          row.append(
            node('span', { className: 'ml-check', textContent: active ? '✓' : '○' }),
            node('span', { className: 'ml-picker-model', textContent: line.model, title: line.model })
          );
          if (isDefault) row.append(node('small', { className: 'ml-badge', textContent: active ? '固定' : '日常对话' }));
          results.append(row);
        }
      }
      if (!lines.length) results.append(node('p', { className: 'ml-muted', textContent: '没有常用模型，请在管理页收藏型号。' }));
    };
    search.addEventListener('input', () => {
      query = search.value;
      paint();
    });
    sheet.replaceChildren(
      head,
      node('p', {
        className: 'ml-muted',
        textContent: `当前使用${runtime === 'server' ? '服务器' : '本机'}配置 · 切换位置会重新载入对应对话`
      }),
      tabs,
      ...(cfg ? [smart] : []),
      search,
      node('p', { className: 'ml-notice', role: 'status', textContent: notice }),
      results,
      makeButton(
        '管理模型与服务商 ›',
        () => {
          dismiss();
          openSettings();
        },
        'ml-manage'
      )
    );
    paint();
    if (pending)
      sheet.querySelectorAll('button').forEach((element) => {
        if (!element.classList.contains('ml-dismiss')) element.disabled = true;
      });
  }
  async function show() {
    const workspace = getWorkspace();
    if (!workspace) return;
    const current = ++ticket;
    query = '';
    notice = '正在读取配置…';
    sheet.hidden = false;
    scrim.hidden = false;
    anchor?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('ml-modal-open');
    render();
    sheet.focus();
    try {
      await workspace.refresh(workspace.runtime);
      if (current === ticket) notice = '';
    } catch (error) {
      if (current === ticket) notice = error.message;
    }
    if (current === ticket && !sheet.hidden) render();
  }
  function dismiss() {
    ticket++;
    sheet.hidden = true;
    scrim.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('ml-modal-open');
    anchor?.focus({ preventScroll: true });
  }
  scrim.addEventListener('click', dismiss);
  document.addEventListener('keydown', (key) => {
    if (sheet.hidden) return;
    if (key.key === 'Escape') dismiss();
    if (key.key !== 'Tab') return;
    const controls = [...sheet.querySelectorAll('button:not(:disabled), input')];
    if (key.shiftKey && (document.activeElement === controls[0] || document.activeElement === sheet)) {
      key.preventDefault();
      controls.at(-1)?.focus();
    } else if (!key.shiftKey && document.activeElement === controls.at(-1)) {
      key.preventDefault();
      controls[0]?.focus();
    }
  });
  return {
    open: show,
    close: dismiss,
    get isOpen() {
      return !sheet.hidden;
    }
  };
}
