/** 手机能力卡片与底部选择器：只调整呈现，读写仍使用原能力表和分位置配置。 */
import { ABILITIES, abilityLines, setAbility } from '../llm/abilities.js';
import { abilityCandidates } from './abilityTable.js';
import { providerLabel, sameLine } from '../llm/modelLibrary.js';
import { keyedProviders } from '../llm/router.js';

const SYMBOLS = { chat: '◌', reason: '▤', code: '⌘', vision: '▧', ocr: '文', image: '◇', embed: '▱' };
const titleOf = (ability) => ({ reason: '深度思考与写作', code: '编程', embed: '记忆检索' })[ability] || ABILITIES[ability].name;

/** 与旧表单保持相同语义：自动备用删字段，不用备用存 null。 */
export function mobileAbilityUpdate(cfg, ability, slot, choice) {
  if (slot === 'backup' && choice === 'auto') {
    const { backup: _drop, ...rest } = cfg.abilities?.[ability] || {};
    return { ...cfg, abilities: { ...cfg.abilities, [ability]: rest } };
  }
  let next = setAbility(cfg, ability, slot, choice?.provider ? choice : null);
  if (slot === 'main' && ability === 'embed') {
    next = { ...next, embedding: { ...next.embedding, engine: choice === 'off' ? 'off' : 'auto' } };
  }
  return next;
}

export function mobileAbilityTable({ cfg, workspace, node, run }) {
  const where = workspace.scope;
  const section = node('section', { className: 'mc-abilities', ariaLabel: '每项能力用哪个模型' });
  section.append(node('h3', { className: 'mc-section-title', textContent: '能力分工' }));
  for (const ability of Object.keys(ABILITIES)) {
    const { main, backup } = abilityLines(cfg, ability);
    const off = ability === 'embed' && cfg.embedding?.engine === 'off';
    const title = titleOf(ability);
    const summary = node('button', { type: 'button', className: 'mc-ability-main', ariaLabel: `配置${title}` });
    const model = off ? '按关键词' : main?.model || '未配置';
    const source = off ? '未启用向量' : main ? providerLabel(cfg, main.provider) : '点此选择服务商与型号';
    summary.append(
      node('span', { className: 'mc-ability-icon', textContent: SYMBOLS[ability], ariaHidden: 'true' }),
      node('span', { className: 'mc-ability-title', textContent: title }),
      node('span', { className: 'mc-ability-model' }, node('strong', { textContent: model, title: model }), node('small', { textContent: source })),
      node('span', { className: 'mc-chevron', textContent: '›', ariaHidden: 'true' })
    );
    const backupButton = node('button', {
      type: 'button', className: 'mc-ability-backup', ariaLabel: `配置${title}备用`,
      textContent: `备用：${backup ? `${backup.model} · ${providerLabel(cfg, backup.provider)}` : '未设置'} ›`
    });
    const card = node('div', { className: 'mc-ability' });
    card.dataset.ability = ability;
    card.append(summary, backupButton);
    const open = (slot, anchor) => openAbilitySheet({ cfg, workspace, node, run, ability, slot, anchor, where });
    summary.addEventListener('click', () => open('main', summary));
    backupButton.addEventListener('click', () => open('backup', backupButton));
    if (ability === 'embed' && !off && main && workspace.memoryStatus) {
      const note = node('small', { className: 'mc-memory-note', role: 'status' });
      card.append(note);
      workspace.memoryStatus(where).then((info) => {
        if (!info?.model) return;
        note.textContent = `向量已就绪 ${info.embedded}/${info.total}${info.lastError ? ` · 上次出错：${info.lastError.message}` : ''}`;
      }).catch(() => { note.textContent = '暂未读到向量状态，可重新打开此页查看'; });
    }
    section.append(card);
  }
  return section;
}

function openAbilitySheet({ cfg, workspace, node, run, ability, slot, anchor, where }) {
  const own = cfg.abilities?.[ability] || {};
  const candidates = abilityCandidates(cfg, ability, [own.main, own.backup]);
  const title = titleOf(ability);
  let activeSlot = slot;
  let shown = 40; // 每次只画 40 条，完整目录仍由原模型库限制每家 1000 条。
  const dialog = node('dialog', { className: 'mc-sheet', ariaLabel: `选择${title}模型` });
  const close = () => dialog.close();
  const dismiss = node('button', { type: 'button', className: 'mc-sheet-close', textContent: '×', ariaLabel: '关闭模型选择' });
  dismiss.addEventListener('click', close);
  const scope = where === 'server' ? '云服务器' : '本机';
  const tabs = node('div', { className: 'mc-slot-tabs', role: 'group', ariaLabel: '选择常用或备用' });
  const search = node('input', { type: 'search', className: 'mc-sheet-search', ariaLabel: '搜索能力模型', placeholder: '搜索型号或服务商', maxLength: 200 });
  const list = node('div', { className: 'mc-sheet-results' });
  const manual = node('form', { className: 'mc-manual', hidden: true });
  const provider = node('select', { ariaLabel: '手动型号服务商' }, ...keyedProviders(cfg).map((id) => node('option', { value: id, textContent: providerLabel(cfg, id) })));
  const model = node('input', { ariaLabel: '手动完整型号', placeholder: '填写完整模型 ID', maxLength: 200, required: true });
  const save = node('button', { type: 'submit', className: 'mc-primary', textContent: '使用此型号' });
  manual.append(provider, model, save);
  const apply = (choice) => {
    const fixedSlot = activeSlot;
    close();
    run(() => fixedSlot === 'main' && ability === 'chat' && choice?.provider
      ? workspace.choose(choice, where)
      : workspace.patch((value) => mobileAbilityUpdate(value, ability, fixedSlot, choice), where));
  };
  manual.addEventListener('submit', (event) => {
    event.preventDefault();
    if (provider.value && model.value.trim()) apply({ provider: provider.value, model: model.value.trim() });
  });
  const addChoice = (label, detail, action, selected = false) => {
    const item = node('button', { type: 'button', className: `mc-choice${selected ? ' selected' : ''}`, ariaPressed: String(selected) },
      node('span', {}, node('strong', { textContent: label }), node('small', { textContent: detail })),
      node('span', { textContent: selected ? '✓' : '›', ariaHidden: 'true' }));
    item.addEventListener('click', action);
    list.append(item);
  };
  function paint() {
    list.replaceChildren();
    manual.hidden = true;
    const current = abilityLines(cfg, ability)[activeSlot];
    if (!search.value.trim()) {
      if (activeSlot === 'backup' || ability !== 'chat') {
        const label = activeSlot === 'main' && ['reason', 'code'].includes(ability) ? '跟随日常对话' : '自动选择';
        addChoice(label, '沿用现有能力选择规则', () => apply('auto'), !own[activeSlot] && own[activeSlot] !== null);
      }
      if (activeSlot === 'backup') addChoice('不用备用', '此能力不指定备用模型', () => apply('none'), own.backup === null);
      if (ability === 'embed' && activeSlot === 'main') addChoice('按关键词检索', '不使用记忆向量', () => apply('off'), cfg.embedding?.engine === 'off');
    }
    const query = search.value.trim().toLowerCase();
    const matches = candidates.filter((line) => `${line.model} ${providerLabel(cfg, line.provider)}`.toLowerCase().includes(query));
    for (const line of matches.slice(0, shown)) {
      addChoice(line.model, providerLabel(cfg, line.provider), () => apply(line), sameLine(current, line));
    }
    if (!matches.length) list.append(node('p', { className: 'ml-muted', textContent: '没有匹配型号，可手动填写，或先到服务商页添加密钥。' }));
    if (matches.length > shown) addChoice('显示更多', `共 ${matches.length} 个匹配`, () => { shown += 40; paint(); });
    const hand = node('button', { type: 'button', className: 'mc-manual-open', textContent: '手动填写型号…', disabled: keyedProviders(cfg).length === 0 });
    hand.addEventListener('click', () => { manual.hidden = !manual.hidden; if (!manual.hidden) model.focus(); });
    list.append(hand);
    for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.slot === activeSlot));
  }
  for (const [value, label] of [['main', '常用模型'], ['backup', '备用模型']]) {
    const tab = node('button', { type: 'button', textContent: label });
    tab.dataset.slot = value;
    tab.addEventListener('click', () => { activeSlot = value; shown = 40; paint(); });
    tabs.append(tab);
  }
  search.addEventListener('input', () => { shown = 40; paint(); });
  dialog.append(node('header', { className: 'mc-sheet-head' }, node('div', {}, node('h3', { textContent: title }), node('small', { textContent: `配置位置：${scope}` })), dismiss), tabs, search, list, manual);
  dialog.addEventListener('click', (event) => { if (event.target === dialog && event.clientY < dialog.getBoundingClientRect().top) close(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (anchor.isConnected) anchor.focus(); }, { once: true });
  document.querySelector('#model-workspace').append(dialog);
  paint();
  dialog.showModal();
  // 不自动聚焦输入框，避免手机一打开就弹键盘挤掉候选项。
  dismiss.focus();
}
