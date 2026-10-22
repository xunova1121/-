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

/** 这项能力能选的型号 */
export function abilityCandidates(cfg, ability) {
  const kind = KIND[ability] || 'chat';
  const out = [];
  const add = (provider, model) => {
    const line = { provider, model };
    if (model && !out.some((item) => sameLine(item, line))) out.push(line);
  };
  // 对话类先放当前默认模型
  if (kind === 'chat' && ability !== 'vision') add(currentLine(cfg).provider, currentLine(cfg).model);
  for (const provider of keyedProviders(cfg)) {
    const start = out.length;
    const ids = cfg.modelLists?.[catalogKey(cfg, provider)]?.ids || [];
    const fits = (id) => modelKind(id) === kind && (ability !== 'vision' || seesImages(id));
    for (const line of favoriteLines(cfg)) if (line.provider === provider && fits(line.model)) add(provider, line.model);
    const row = CAPABILITIES[ability]?.find((item) => item.provider === provider);
    if (row?.model) add(provider, row.model);
    for (const id of ids) if (fits(id) && out.length - start < PER_PROVIDER) add(provider, id);
  }
  return out;
}

const label = (cfg, line) => (line ? `${providerLabel(cfg, line.provider)} · ${line.model}` : '');

/** 某项能力现在实际用谁（“自动”时显示自动挑到的） */
function describe(cfg, ability) {
  if (ability === 'embed' && cfg.embedding?.engine === 'off') return '现在：不用向量，记忆只按关键字找';
  const { main, backup } = abilityLines(cfg, ability);
  if (!main) return ability === 'embed' ? '现在：没有能做向量的服务商，记忆只按关键字找（填智谱、百炼或硅基流动的 Key 就能用）' : '现在：还没有能做这件事的服务商——先在上面填一家的 Key（如智谱、百炼、OpenAI）';
  return `现在：${label(cfg, main)}${backup ? `；出错换 ${label(cfg, backup)}` : '；没有备用'}`;
}

/**
 * @param {{ cfg: object, workspace: { patch: Function, choose: Function }, node: Function, run: Function }} o
 */
export function abilityTable({ cfg, workspace, node, run }) {
  const rows = Object.entries(ABILITIES).map(([ability, meta]) => {
    const list = abilityCandidates(cfg, ability);
    const own = cfg.abilities?.[ability] || {};
    const auto = abilityLines({ ...cfg, abilities: { ...cfg.abilities, [ability]: {} } }, ability);
    // “自动”备用是按选定的常用来找的
    const autoBackup = abilityLines({ ...cfg, abilities: { ...cfg.abilities, [ability]: own.main ? { main: own.main } : {} } }, ability).backup;
    const option = (value, textContent) => node('option', { value, textContent });
    // 每个下拉框要自己的一套选项（同一个元素放进第二个下拉框会从第一个里移走）
    const lineOptions = () => list.map((line, i) => option(String(i), label(cfg, line)));
    const indexOf = (line) => (line ? list.findIndex((item) => sameLine(item, line)) : -1);

    // 常用：日常对话就是默认模型（改它等于换默认）；其余可以“自动”或“跟日常对话一样”
    const main = node('select', { className: 'ml-ability-select', ariaLabel: `${meta.name} 常用` });
    if (ability === 'chat') main.append(...lineOptions());
    else {
      const autoText = ['reason', 'code'].includes(ability) ? '跟日常对话一样' : `自动（${auto.main ? label(cfg, auto.main) : '暂无'}）`;
      main.append(option('auto', autoText), ...(ability === 'embed' ? [option('off', '不用（只按关键字）')] : []), ...lineOptions());
    }
    const current = abilityLines(cfg, ability).main;
    main.value = ability === 'chat' ? String(indexOf(current)) : ability === 'embed' && cfg.embedding?.engine === 'off' ? 'off' : own.main && indexOf(own.main) >= 0 ? String(indexOf(own.main)) : 'auto';
    main.addEventListener('change', () => {
      const line = list[Number(main.value)];
      if (ability === 'chat') return line && run(() => workspace.choose(line));
      run(() =>
        workspace.patch((value) => {
          let next = setAbility(value, ability, 'main', line || null);
          // 向量：选了具体型号或“自动”都按能力表走；“不用”就关掉
          if (ability === 'embed') next = { ...next, embedding: { ...next.embedding, engine: main.value === 'off' ? 'off' : 'auto' } };
          return next;
        })
      );
    });

    // 备用：自动 / 不用备用 / 指定
    const backup = node('select', { className: 'ml-ability-select', ariaLabel: `${meta.name} 备用` }, option('auto', `自动（${autoBackup ? label(cfg, autoBackup) : '暂无'}）`), option('none', '不用备用'), ...lineOptions());
    backup.value = own.backup === null ? 'none' : own.backup && indexOf(own.backup) >= 0 ? String(indexOf(own.backup)) : 'auto';
    backup.addEventListener('change', () =>
      run(() =>
        workspace.patch((value) => {
          if (backup.value === 'auto') {
            const { backup: _drop, ...rest } = value.abilities?.[ability] || {};
            return { ...value, abilities: { ...value.abilities, [ability]: rest } };
          }
          return setAbility(value, ability, 'backup', backup.value === 'none' ? null : list[Number(backup.value)]);
        })
      )
    );
    return node(
      'div',
      { className: 'ml-ability' },
      node('div', { className: 'ml-ability-name' }, node('strong', { textContent: meta.name }), node('small', { textContent: meta.hint })),
      node('label', { className: 'ml-ability-slot' }, node('span', { textContent: '常用' }), main),
      node('label', { className: 'ml-ability-slot' }, node('span', { textContent: '备用' }), backup),
      node('small', { className: 'ml-ability-now', textContent: describe(cfg, ability) })
    );
  });
  return node(
    'section',
    { className: 'ml-abilities', ariaLabel: '每项能力用哪个模型' },
    node('h3', { className: 'ml-heading', textContent: '每项能力用哪个模型' }),
    node('p', { className: 'ml-muted', textContent: '下拉框只列上面填了 Key 的服务商。“自动”按各家擅长的挑；常用出错时自动换备用。' }),
    ...rows
  );
}
