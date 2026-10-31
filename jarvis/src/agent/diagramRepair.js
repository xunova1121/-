/**
 * 普通画图（没要求逐条核对需求原文）时，模型填的参数不合版式规则就由程序就地调整，不让模型反复重填。
 * 用户 2026-10-29 实测：轻量模型画项目架构图，连续三次被“分栏层需2～4个节点”“通栏只支持内容标题和说明”
 * “应用集成须通过已审架构底稿投影”拦下，最后一张图都没交。
 *
 *   - 只改版式（层类型、标签位置、分组），不删节点、不改名称和数字；放不下的说明并进 detail
 *   - 每处调整都记一句 notes，回执里照实告诉模型和用户
 *   - 严格模式（逐条核对需求原文 / 有架构底稿）不经过这里，原规则不放松
 */
import { layoutDiagram } from './diagramModel.js';
import { DIAGRAM_ICONS } from './diagramCards.js';

const chars = (s) => [...String(s ?? '')];
const cut = (s, n) => (chars(s).length > n ? chars(s).slice(0, n - 1).join('') + '…' : String(s ?? ''));
const isCard = (node) => Boolean(node.icon || node.accent || node.badge || node.bullets);
/** 把副标题、要点、标签并进说明（不丢字，超长才截断并记下来） */
function flatten(node, notes, keepCard = false) {
  const next = { ...node };
  const extra = [];
  if (next.subtitle) extra.push(next.subtitle);
  delete next.subtitle;
  if (!keepCard) {
    if (Array.isArray(next.bullets)) extra.push(next.bullets.map((b) => (typeof b === 'string' ? b : b?.text || b?.title || '')).filter(Boolean).join('、'));
    if (next.badge) extra.push(next.badge);
    delete next.bullets;
    delete next.badge;
    delete next.icon;
    delete next.accent;
  }
  if (extra.length) {
    const detail = [next.detail, ...extra].filter(Boolean).join('；');
    if (chars(detail).length > 160) notes.push(`「${next.title}」说明超过160字，已截断`);
    next.detail = cut(detail, 160);
  }
  return next;
}
function cleanNode(node, notes) {
  if (!node || typeof node !== 'object') return null;
  const next = { ...node };
  if (chars(next.title).length > 48) {
    notes.push(`「${cut(next.title, 12)}」标题过长，多出的部分移到说明`);
    next.detail = cut([chars(next.title).slice(48).join(''), next.detail].filter(Boolean).join('；'), 160);
    next.title = chars(next.title).slice(0, 48).join('');
  }
  if (next.detail && chars(next.detail).length > 160) {
    notes.push(`「${cut(next.title, 12)}」说明超过160字，已截断`);
    next.detail = cut(next.detail, 160);
  }
  if (next.icon !== undefined && !DIAGRAM_ICONS.includes(next.icon)) delete next.icon;
  if (next.accent !== undefined && !['orange', 'blue', 'green'].includes(next.accent)) delete next.accent;
  if (next.badge && chars(next.badge).length > 28) next.badge = cut(next.badge, 28);
  // 要点写成纯文字（模型常这样写）：转成 { text }，不当错误
  if (Array.isArray(next.bullets)) next.bullets = next.bullets.map((b) => (typeof b === 'string' ? { text: cut(b, 40) } : b && typeof b === 'object' && b.text ? { ...b, ...(b.icon && !DIAGRAM_ICONS.includes(b.icon) && { icon: undefined }) } : b)).map((b) => (b && b.icon === undefined ? { text: b.text } : b));
  if (next.bullets !== undefined && (!Array.isArray(next.bullets) || next.bullets.length < 2 || next.bullets.length > 5)) {
    const list = Array.isArray(next.bullets) ? next.bullets : [next.bullets];
    if (list.length > 5) {
      next.detail = cut([next.detail, list.slice(5).map((b) => (typeof b === 'string' ? b : b?.text || '')).join('、')].filter(Boolean).join('；'), 160);
      next.bullets = list.slice(0, 5);
    } else {
      next.detail = cut([next.detail, list.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('、')].filter(Boolean).join('；'), 160);
      delete next.bullets;
    }
  }
  return next;
}
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/** 一层按规则调整：返回一层或拆成几层 */
function repairLayer(layer, notes) {
  const nodes = (layer.nodes || []).map((n) => cleanNode(n, notes)).filter(Boolean);
  if (!nodes.length) {
    notes.push(`「${layer.title}」层没有节点，已去掉`);
    return [];
  }
  let kind = layer.kind ?? 'cards';
  const base = { ...layer, nodes };
  const toCards = (why) => {
    notes.push(`「${layer.title}」${why}，改为卡片层`);
    kind = 'cards';
  };
  if (kind === 'band' && (nodes.length !== 1 || nodes.some(isCard))) toCards('通栏只能放一个纯文字内容');
  if (kind === 'grid' && (nodes.length < 8 || nodes.some((n) => n.detail || n.subtitle || isCard(n)))) toCards(nodes.length < 8 ? '网格需8个以上模块' : '网格只放标题，带说明的');
  if (kind === 'columns' && (nodes.length < 2 || nodes.length > 4 || nodes.some((n) => n.bullets || n.badge))) toCards('分栏只放2～4个');
  if (kind === 'cards' && nodes.length > 12 && nodes.length <= 18 && !nodes.some((n) => n.detail || isCard(n))) {
    notes.push(`「${layer.title}」${nodes.length}个模块，改为网格`);
    kind = 'grid';
  }
  // 通栏左侧标题位只有一行约9个字：括号里的说明挪进正文，标题仍放不下就整句挪进正文、标题留空位前半句
  if (kind === 'band' && nodes.length === 1 && chars(layer.title).length > 9) {
    const [, head, note] = String(layer.title).match(/^(.*?)\s*[（(](.*)[)）]\s*$/) || [null, layer.title, ''];
    const fits = chars(head).length <= 9;
    base.title = fits ? head : chars(head).slice(0, 8).join('');
    const moved = [fits ? '' : layer.title, note].filter(Boolean).join('，');
    if (moved) nodes[0] = { ...nodes[0], detail: cut([moved, nodes[0].detail].filter(Boolean).join('：'), 160) };
    notes.push(`通栏标题“${layer.title}”放不下一行，${note ? '括号说明' : '完整标题'}已挪进正文`);
  }
  const fixed = nodes.map((n) => (kind === 'band' || kind === 'cards' ? flatten(n, notes, kind === 'cards') : kind === 'columns' ? n : flatten(n, notes)));
  const max = kind === 'grid' || kind === 'catalog' ? 18 : 12;
  if (fixed.length <= max) return [{ ...base, kind, nodes: fixed }];
  notes.push(`「${layer.title}」${fixed.length}个节点超过一层上限${max}，拆成${Math.ceil(fixed.length / max)}层`);
  return chunk(fixed, max).map((part, i) => ({ ...base, kind, title: i ? cut(`${layer.title}（续${i}）`, 48) : layer.title, nodes: part }));
}

/**
 * 纯格式整理，严格模式（按文档逐条核对 / 架构底稿）也做：只动可选的装饰字段，不碰标题、说明、节点和关系。
 * 用户 2026-10-30 实测：按汇报文档画架构图，卡片标签给了空串、平台分组名超长，整张图在排版前就被拦下，前后三次。
 *   - 卡片标签（badge）空的去掉（本来可不填），超过28字截短
 *   - 平台分组名（group）空的去掉，超过48字截短（同名分组截法相同，仍算同一组）
 * @returns {{ input: object, notes: string[] }}
 */
export function tidyLabels(input) {
  const notes = [];
  if (!Array.isArray(input?.layers)) return { input, notes };
  const layers = input.layers.map((layer) => {
    if (!layer || typeof layer !== 'object') return layer;
    const next = { ...layer };
    if (next.group !== undefined && (typeof next.group !== 'string' || !next.group.trim())) delete next.group;
    else if (next.group !== undefined && chars(next.group.trim()).length > 48) {
      notes.push(`平台分组名“${cut(next.group, 12)}”超过48字，已截短`);
      next.group = cut(next.group.trim(), 48);
    }
    if (Array.isArray(next.nodes))
      next.nodes = next.nodes.map((node) => {
        if (!node || typeof node !== 'object' || node.badge === undefined) return node;
        const { badge, ...rest } = node;
        if (typeof badge !== 'string' || !badge.trim()) return rest;
        if (chars(badge.trim()).length <= 28) return node;
        notes.push(`「${cut(node.title, 12)}」卡片标签超过28字，已截短`);
        return { ...rest, badge: cut(badge.trim(), 28) };
      });
    return next;
  });
  return { input: { ...input, layers }, notes: [...new Set(notes)] };
}

/**
 * 版式调整（不碰内容）
 * @returns {{ input: object, notes: string[] }}
 */
export function repairDiagramInput(raw) {
  const { input, notes } = tidyLabels(raw);
  if (!Array.isArray(input.layers)) return { input, notes };
  let layers = input.layers.flatMap((layer) => repairLayer(layer, notes));
  if (layers.length > 8) {
    notes.push(`共${layers.length}层超过8层，最后几层合并成一层卡片`);
    const tail = layers.slice(7).flatMap((l) => l.nodes.map((n) => flatten(n, notes, true)));
    layers = [...layers.slice(0, 7), ...repairLayer({ title: layers[7].title, kind: 'cards', nodes: tail }, notes)].slice(0, 8);
  }
  // 平台分组必须连续、最多3组：不连续或超出的去掉分组框（节点照画）
  const seen = new Set();
  let prev;
  layers = layers.map((layer) => {
    const g = layer.group;
    if (g && g !== prev && (seen.has(g) || seen.size >= 3)) {
      notes.push(`「${layer.title}」的分组“${g}”不连续或超过3组，去掉分组框`);
      prev = undefined;
      const { group: _, ...rest } = layer;
      return rest;
    }
    if (g) seen.add(g);
    prev = g;
    return layer;
  });
  const ids = new Set(layers.flatMap((l) => l.nodes.map((n) => n.id)));
  const pairs = new Set();
  const edges = (input.edges || []).flatMap((edge) => {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) {
      notes.push(`连线 ${edge?.from}→${edge?.to} 指向不存在的节点或自身，已去掉`);
      return [];
    }
    const next = { ...edge };
    if (next.type === 'integration') {
      delete next.type; // 没有架构底稿时按普通连线画
      notes.push('应用集成关系按普通连线画（没有逐条核对的架构底稿）');
    }
    if (next.label !== undefined && chars(next.label).length > 12) next.label = cut(next.label, 12);
    const key = next.from + '>' + next.to;
    if (pairs.has(key)) return [];
    pairs.add(key);
    return [next];
  });
  return { input: { ...input, layers, edges }, notes: [...new Set(notes)] };
}

/** 去掉放不下的箭头文字（文字箭头只能在同排相邻卡片之间），箭头本身保留 */
const stripLabels = (input) => ({ ...input, edges: (input.edges || []).map(({ label: _, ...edge }) => edge) });

/**
 * 普通画图：先调整版式再排版；仍因箭头文字位置报错时去掉箭头文字再排一次
 * @returns {{ model: object, input: object, notes: string[] }}
 */
/**
 * 分层架构图：层与层的上下排列已经表达支撑关系，跨层连线走右侧通道会层层交叉（用户 2026-10-29 07:06 实测“好多线，乱七八糟”，
 * 视觉检查也因“连线过密”不通过，PNG/PDF/PPT 都没导出）。只保留同一层里的连线，跨层的去掉并记下条数
 */
export function dropCrossLayer(input) {
  const layerOf = new Map(input.layers.flatMap((layer, i) => layer.nodes.map((node) => [node.id, i])));
  const kept = (input.edges || []).filter((edge) => layerOf.get(edge.from) === layerOf.get(edge.to));
  const dropped = (input.edges || []).length - kept.length;
  return { input: { ...input, edges: kept }, note: dropped ? `跨层连线 ${dropped} 条已省略：层与层的支撑关系由上下排列表示，避免连线交叉` : '' };
}

/**
 * @param {object} raw
 * @param {{ architecture?: boolean }} [o]  分层架构图：去掉跨层连线
 */
export function layoutWithRepair(raw, { architecture = false } = {}) {
  let { input, notes } = repairDiagramInput(raw);
  if (architecture) {
    const cut = dropCrossLayer(input);
    input = cut.input;
    if (cut.note) notes = [...notes, cut.note];
  }
  try {
    return { model: layoutDiagram(input), input, notes };
  } catch (error) {
    if (!/带字|箭头|重复连线标签/.test(String(error?.message))) throw error;
    const plain = stripLabels(input);
    return { model: layoutDiagram(plain), input: plain, notes: [...notes, '箭头文字只能放在同排相邻卡片之间，跨层箭头的文字已去掉，箭头保留'] };
  }
}
