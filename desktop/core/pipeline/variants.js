/**
 * 变体：同一个角色的不同穿搭、同一个场景的内景外景 / 白天夜里。
 *
 * ── 为什么不能直接拆成两个条目 ──
 *
 * 「阿澜」和「阿澜（便装）」如果是两条独立设定，它们之间**没有任何关系**：
 * 两颗不同的种子、两张各自发挥的设定图、复核时还会互相判成不一致。
 * 结果就是换套衣服等于换了个人。场景同理 —— 「码头·晨雾」和「码头·夜雨」
 * 拆开之后，凭什么保证它们还是同一个码头？
 *
 * ── 真正的拆法：把"永不变的"和"这一版变的"分开 ──
 *
 *   身份锚（item.appearance）  脸型、发型发色、瞳色、身形 / 建筑、地貌、标志物
 *                              全片唯一，**永不随剧情变化**
 *   变体（item.variants[]）    只写会变的那部分：这套衣服 / 这个时段的光线
 *
 * 三件事保证"还是同一个人 / 同一个地方"：
 *   ① 所有变体**共用条目的种子**（身份种子），采样起点一致；
 *   ② 每个变体的出图提示词都 = 身份锚 + 变体描述，身份锚永远在场；
 *   ③ 一致性复核优先拿**同一个变体**的设定图当基准；只能拿别的变体比对时，
 *      会明确告诉复核模型"忽略服装差异，只看是不是同一个人"——
 *      否则换套衣服必然被判不一致，重试到死也过不了。
 *
 * ── 兼容 ──
 *
 * 老项目的条目没有 variants。读的时候补一个"默认"变体，把条目原有的
 * sheetPath / sheetUrl 挪进去（见 store.read）。条目上那两个字段**保留**
 * 并始终镜像默认变体 —— 全代码库引用它们的地方太多，一次性改完风险远大于收益。
 */

import * as angles from './angles.js';

/** 默认变体的固定 id。同一个条目里它永远是第一个。 */
export const DEFAULT_VARIANT_ID = 'v-default';

export const VARIANT_LABELS = {
  char: { title: '造型', hint: '同一个人的不同穿搭。脸不变，只换衣服/发型细节' },
  scene: { title: '时段 / 内外景', hint: '同一个地方的不同光线。建筑不变，只换天气时段' },
  prop: { title: '状态', hint: '同一件东西的不同状态：完好 / 破损 / 打开' }
};

function newId() {
  return `v-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把一个条目规整成"一定有变体"的形状。**就地修改**，幂等。
 *
 * 在读取时做而不是写迁移脚本：迁移跑一半失败会留下半新半旧的数据，
 * 而这种补法每次读都得到同一个结果。
 */
export function normalizeItem(item, kind = 'char') {
  if (!item || typeof item !== 'object') return item;
  if (!Array.isArray(item.variants) || !item.variants.length) {
    item.variants = [
      {
        id: DEFAULT_VARIANT_ID,
        name: kind === 'char' ? '默认造型' : kind === 'scene' ? '默认时段' : '默认状态',
        // 默认变体不写额外描述：它就是身份锚本身
        appearance: '',
        sheetPath: item.sheetPath || null,
        sheetUrl: item.sheetUrl || null,
        sheetAt: item.sheetAt || null,
        sheetSource: item.sheetSource || null,
        sheetPromptUsed: item.sheetPromptUsed || '',
        // 出图提示词的覆盖只存在**变体**上。迁移时从条目搬过来一次之后，
        // 条目那份就不再有人读了（见 studio.sheetPrompt 里的注释）——
        // 同一个值有两个存放处、只有一处会被更新，是那个 bug 复发的根源
        sheetPrompt: item.sheetPrompt || ''
      }
    ];
  }
  // 角度（正/侧/背）挂在变体下面，和变体正交 —— 见 angles.js 开头
  for (const v of item.variants) angles.normalizeVariant(v);
  // 条目上这几个字段始终镜像默认变体。
  // 保留镜像而不是全代码库改引用：引用它们的地方太多，一次性改完风险远大于收益。
  const first = item.variants[0];
  item.sheetPath = first.sheetPath || null;
  item.sheetUrl = first.sheetUrl || null;
  item.sheetAt = first.sheetAt || null;
  item.sheetSource = first.sheetSource || null;
  item.sheetPromptUsed = first.sheetPromptUsed || '';
  item.sheetFileName = first.sheetFileName || '';
  return item;
}

export function normalizeBible(bible) {
  if (!bible) return bible;
  for (const c of bible.characters || []) normalizeItem(c, 'char');
  for (const s of bible.scenes || []) normalizeItem(s, 'scene');
  for (const p of bible.props || []) normalizeItem(p, 'prop');
  return bible;
}

export function variantsOf(item) {
  return Array.isArray(item?.variants) && item.variants.length ? item.variants : [];
}

export function defaultVariant(item) {
  return variantsOf(item)[0] || null;
}

export function findVariant(item, id) {
  if (!id) return null;
  return variantsOf(item).find((v) => v.id === id) || null;
}

/**
 * 这一镜该用这个条目的哪个变体。
 *
 * 分镜上记的是 `shot.variants = { '阿澜': 'v-xxx', '码头': 'v-yyy' }` ——
 * 按**名字**索引而不是按下标，因为设定集里增删条目是常事，下标会错位。
 * 没指定就用默认变体：绝大多数镜头本来就不需要换装。
 */
export function pickVariant(item, shot) {
  const wanted = shot?.variants?.[item?.name];
  return findVariant(item, wanted) || defaultVariant(item);
}

/**
 * 出图 / 提示词里用的完整描述 = 身份锚 + 这一版变的那部分。
 *
 * 顺序是身份在前：越靠后越容易被稀释，而"是不是同一个人"比"穿什么"要紧。
 */
export function describeWith(item, variant) {
  const base = String(item?.appearance || '').trim();
  const extra = String(variant?.appearance || '').trim();
  if (!extra) return base;
  return base ? `${base}，${extra}` : extra;
}

/** 新建一个变体。种子不给它自己的 —— 共用条目的身份种子才保得住同一张脸。 */
export function makeVariant({ name, appearance = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('变体要有名字，比如「雨夜外套」「内景·值班室」');
  return {
    id: newId(),
    name: clean,
    appearance: String(appearance || '').trim(),
    sheetPath: null,
    sheetUrl: null,
    sheetAt: null,
    sheetSource: null,
    sheetPromptUsed: '',
    sheetPrompt: '',
    // 正面之外的角度，补出来才会有（见 angles.js）
    angles: []
  };
}

/**
 * 全片一共要出多少张设定图、还差几张。
 * 按**变体**数，不是按条目数 —— 三套衣服就是三张，缺一张就少一个基准。
 */
export function sheetTargets(bible) {
  const out = [];
  const push = (kind, items) => {
    for (const item of items || []) {
      for (const v of variantsOf(item)) out.push({ kind, item, variant: v });
    }
  };
  push('char', bible?.characters);
  push('scene', bible?.scenes);
  push('prop', bible?.props);
  return out;
}

/** 显示用名字：默认变体只显示条目名，别在界面上到处挂一个"默认造型" */
export function labelOf(item, variant) {
  if (!variant || variant.id === DEFAULT_VARIANT_ID) return item?.name || '';
  return `${item?.name || ''}·${variant.name}`;
}
