/**
 * 模型页“每项能力用哪个模型”：日常对话、深度思考/写作、写代码、看图、画图、记忆向量，各选一个常用、一个备用。
 * 下拉框只列填了 Key 的服务商的型号（常用收藏、拉取到的同类型号、能力表推荐型号）；“自动”按能力表挑（见 llm/abilities.js）。
 * 每行下面一行小字：现在实际用谁、出错换谁。
 */
import { ABILITIES, CAPABILITIES, abilityLines, setAbility } from '../llm/abilities.js';
import { keyedProviders, seesImages } from '../llm/router.js';
import { modelKind } from '../llm/images.js';
import { providerLabel, favoriteLines, catalogKey, sameLine, currentLine } from '../llm/modelLibrary.js';

const KIND = { image: 'image', embed: 'embed' };
const PER_PROVIDER = 30;

/**
 * 这项能力能选的型号
 *   收藏的型号不按名字猜（你确认过的，以你为准）；拉取到的型号按名字认类别；extra：已经设过的（含手动填写的）
 */
export function abilityCandidates(cfg, ability, extra = []) {
  const kind = KIND[ability] || 'chat';
  const out = [];
  const add = (provider, model) => {
    const line = { provider, model };
    if (model && !out.some((item) => sameLine(item, line))) out.push(line);
  };
  // 对话类先放当前默认模型
  if (kind === 'chat' && !['vision', 'ocr'].includes(ability)) add(currentLine(cfg).provider, currentLine(cfg).model);
  for (const provider of keyedProviders(cfg)) {
    const start = out.length;
    const ids = cfg.modelLists?.[catalogKey(cfg, provider)]?.ids || [];
    const fits = (id) => (ability === 'ocr' ? /ocr/i.test(id) : modelKind(id) === kind && (ability !== 'vision' || seesImages(id)));
    for (const line of favoriteLines(cfg)) if (line.provider === provider && (kind === 'chat' && ability !== 'ocr' ? modelKind(line.model) === 'chat' : fits(line.model))) add(provider, line.model);
    const row = CAPABILITIES[ability]?.find((item) => item.provider === provider);
    if (row?.model) add(provider, row.model);
    for (const id of ids) if (fits(id) && out.length - start < PER_PROVIDER) add(provider, id);
  }
  for (const line of extra) if (line?.provider && line?.model) add(line.provider, line.model);
  return out;
}

const label = (cfg, line) => (line ? `${providerLabel(cfg, line.provider)} · ${line.model}` : '');

/** 某项能力现在实际用谁（“自动”时显示自动挑到的） */
function describe(cfg, ability) {
  if (ability === 'embed' && cfg.embedding?.engine === 'off') return '现在：不用向量，记忆只按关键字找';
  const { main, backup } = abilityLines(cfg, ability);
  if (!main && ability === 'ocr') return '现在：没有能做文字识别的服务商（填上智谱的 Key 就自动用 GLM-OCR）；图片里的字先交给看图模型读';
  if (!main) return ability === 'embed' ? '现在：没有能做向量的服务商，记忆只按关键字找（填智谱、百炼或硅基流动的 Key 就能用）' : '现在：还没有能做这件事的服务商——先在上面填一家的 Key（如智谱、百炼、OpenAI）';
  return `现在：${label(cfg, main)}${backup ? `；出错换 ${label(cfg, backup)}` : '；没有备用'}`;
}

/**
 * @param {{ cfg: object, workspace: { patch: Function, choose: Function }, node: Function, run: Function }} o
 */
export function abilityTable({ cfg, workspace, node, run }) {
  const rows = Object.entries(ABILITIES).map(([ability, meta]) => {
    const own = cfg.abilities?.[ability] || {};
    const list = abilityCandidates(cfg, ability, [own.main, own.backup]);
    const auto = abilityLines({ ...cfg, abilities: { ...cfg.abilities, [ability]: {} } }, ability);
    // “自动”备用是按选定的常用来找的
    const autoBackup = abilityLines({ ...cfg, abilities: { ...cfg.abilities, [ability]: own.main ? { main: own.main } : {} } }, ability).backup;
    const option = (value, textContent) => node('option', { value, textContent });
    // 每个下拉框要自己的一套选项（同一个元素放进第二个下拉框会从第一个里移走）
    const lineOptions = () => [...list.map((line, i) => option(String(i), label(cfg, line))), option('manual', '手动填写型号…')];
    const indexOf = (line) => (line ? list.findIndex((item) => sameLine(item, line)) : -1);

    /** 存一项：line 是具体型号，或 'auto' / 'none'（不用备用）/ 'off'（不用向量） */
    const apply = (slot, choice) => {
      if (slot === 'main' && ability === 'chat') return choice?.provider && run(() => workspace.choose(choice));
      run(() =>
        workspace.patch((value) => {
          if (slot === 'backup' && choice === 'auto') {
            const { backup: _drop, ...rest } = value.abilities?.[ability] || {};
            return { ...value, abilities: { ...value.abilities, [ability]: rest } };
          }
          let next = setAbility(value, ability, slot, choice?.provider ? choice : null);
          // 向量：选了具体型号或“自动”都按能力表走；“不用”就关掉
          if (slot === 'main' && ability === 'embed') next = { ...next, embedding: { ...next.embedding, engine: choice === 'off' ? 'off' : 'auto' } };
          return next;
        })
      );
    };

    // 手动填写：选哪家服务商 + 型号名
    const manual = node('div', { className: 'ml-ability-manual', hidden: true });
    let manualSlot = 'main';
    const providerSelect = node('select', { ariaLabel: `${meta.name} 手动填写的服务商` }, ...keyedProviders(cfg).map((id) => option(id, providerLabel(cfg, id))));
    const modelInput = node('input', { placeholder: '完整型号名，如 glm-4.6v', maxLength: 200, ariaLabel: `${meta.name} 手动填写的型号` });
    const ok = node('button', { type: 'button', className: 'ml-small', textContent: '确定' });
    const cancel = node('button', { type: 'button', className: 'ml-small', textContent: '取消' });
    manual.append(providerSelect, modelInput, ok, cancel);

    // 常用：日常对话就是默认模型（改它等于换默认）；其余可以“自动”或“跟日常对话一样”
    const main = node('select', { className: 'ml-ability-select', ariaLabel: `${meta.name} 常用` });
    if (ability === 'chat') main.append(...lineOptions());
    else {
      const autoText = ['reason', 'code'].includes(ability) ? '跟日常对话一样' : `自动（${auto.main ? label(cfg, auto.main) : '暂无'}）`;
      main.append(option('auto', autoText), ...(ability === 'embed' ? [option('off', '不用（只按关键字）')] : []), ...lineOptions());
    }
    const current = abilityLines(cfg, ability).main;
    const mainValue = ability === 'chat' ? String(indexOf(current)) : ability === 'embed' && cfg.embedding?.engine === 'off' ? 'off' : own.main && indexOf(own.main) >= 0 ? String(indexOf(own.main)) : 'auto';
    main.value = mainValue;

    // 备用：自动 / 不用备用 / 指定
    const backup = node('select', { className: 'ml-ability-select', ariaLabel: `${meta.name} 备用` }, option('auto', `自动（${autoBackup ? label(cfg, autoBackup) : '暂无'}）`), option('none', '不用备用'), ...lineOptions());
    const backupValue = own.backup === null ? 'none' : own.backup && indexOf(own.backup) >= 0 ? String(indexOf(own.backup)) : 'auto';
    backup.value = backupValue;

    const onPick = (slot, select) => () => {
      const v = select.value;
      if (v === 'manual') {
        manualSlot = slot;
        manual.hidden = false;
        modelInput.focus();
        return;
      }
      manual.hidden = true;
      apply(slot, /^\d+$/.test(v) ? list[Number(v)] : v);
    };
    main.addEventListener('change', onPick('main', main));
    backup.addEventListener('change', onPick('backup', backup));
    ok.addEventListener('click', () => {
      const model = modelInput.value.trim();
      if (!model) return modelInput.focus();
      apply(manualSlot, { provider: providerSelect.value, model });
    });
    cancel.addEventListener('click', () => {
      manual.hidden = true;
      main.value = mainValue;
      backup.value = backupValue;
    });
    return node(
      'div',
      { className: 'ml-ability' },
      node('div', { className: 'ml-ability-name' }, node('strong', { textContent: meta.name }), node('small', { textContent: meta.hint })),
      node('label', { className: 'ml-ability-slot' }, node('span', { textContent: '常用' }), main),
      node('label', { className: 'ml-ability-slot' }, node('span', { textContent: '备用' }), backup),
      manual,
      node('small', { className: 'ml-ability-now', textContent: describe(cfg, ability) })
    );
  });
  return node(
    'section',
    { className: 'ml-abilities', ariaLabel: '每项能力用哪个模型' },
    node('h3', { className: 'ml-heading', textContent: '每项能力用哪个模型' }),
    node('p', { className: 'ml-muted', textContent: '下拉框只列上面填了 Key 的服务商；没有想要的型号就选“手动填写型号…”。“自动”按各家擅长的挑；常用出错时自动换备用。' }),
    ...rows
  );
}
