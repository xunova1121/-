/**
 * 设定图的**角度**：同一个人的正面 / 侧面 / 背面，同一个场景的不同朝向。
 *
 * ── 补的是哪个洞 ──
 *
 * 到现在为止，一个角色只有一张「正面半身」。于是凡是人不正对镜头的镜头 ——
 * 背影走远、侧脸对话、转身推门 —— 参考图给的都是一张正脸，
 * 模型只能自己脑补背面长什么样。后脑勺的发型、衣服背后的样子每一镜都在变，
 * 而**这件事不会报错**，只会让人觉得"他一转身就换了个人"。
 *
 * 场景同理：只有一张广角空镜，人物一往左走出画，左边那面墙是什么样全靠猜。
 *
 * ── 为什么是"角度"而不是又一个变体 ──
 *
 * 变体（variants.js）分的是**这一版和那一版不同**：换了套衣服、换了个时段。
 * 角度分的是**同一版从哪边看**。两者是正交的：夜戏那版也有正侧背三面。
 * 混进变体里的话，"雨夜外套·背面"会变成一个独立变体，
 * 它和"雨夜外套"之间就没有任何关系了 —— 正是 variants.js 开头说的那个坑。
 *
 * 所以角度挂在**变体下面**：variant.angles[]。
 *
 * ── 主图去哪了 ──
 *
 * 每个变体原有的 sheetPath / sheetUrl **就是主角度**（角色的正面、场景的广角）。
 * 不动它 —— 全代码库引用它的地方太多，而且老项目读出来就该照常能用。
 * angles[] 里只放**额外补出来的那几张**。
 */

/** 主角度的固定 id。它不在 angles[] 里，它就是变体自己那张 sheet。 */
export const PRIMARY = 'primary';

/**
 * 每一类各有哪些角度。
 *
 * 道具没有：产品图视角已经够用，多出两张只是多花钱。
 * 真要多角度的道具（比如一辆车），用变体或者直接上传更合适。
 */
export const ANGLE_SETS = {
  char: [
    { id: PRIMARY, label: '正面', hint: '主图。半身正面，五官最好辨认' },
    { id: 'side', label: '侧面', hint: '侧脸对话、侧身走位时用得上' },
    { id: 'back', label: '背面', hint: '背影、转身离开时用得上。后脑勺和衣服背面最容易每镜都变' }
  ],
  scene: [
    { id: PRIMARY, label: '广角全貌', hint: '主图。空镜广角' },
    { id: 'left', label: '左侧', hint: '镜头转向左边时的那一面' },
    { id: 'right', label: '右侧', hint: '镜头转向右边时的那一面' },
    { id: 'top', label: '俯视平面', hint: '家具布局俯视图。俯拍镜头用得上，也是预演台排位的底图' }
  ],
  prop: [{ id: PRIMARY, label: '产品图', hint: '单体居中，一张就够' }]
};

export function anglesFor(kind) {
  return ANGLE_SETS[kind] || ANGLE_SETS.char;
}

export function labelOf(kind, angleId) {
  return anglesFor(kind).find((a) => a.id === angleId)?.label || angleId;
}

/** 除主图之外还能补的那些（界面上"补出其他角度"列的就是它） */
export function extraAngles(kind) {
  return anglesFor(kind).filter((a) => a.id !== PRIMARY);
}

/**
 * 出这张角度图的提示词片段。
 *
 * 两件事必须同时说：**换个角度**，以及**别换人**。
 * 只说前者的话，模型很乐意给你一个"侧面的另一个人" ——
 * 而那比没有这张图更糟：它会被当成同一个人的参考图发出去。
 *
 * 真正锁住身份的还是参考图（拿主图去做图生图，见 studio.generateAngles），
 * 这几句话是第二道保险。
 */
export function promptFor(kind, angleId) {
  if (kind === 'char') {
    if (angleId === 'side') {
      return '正侧面视角（脸朝向画面左侧，看不到另一侧脸颊），同一个人，五官、发型、发色、服装、配饰完全不变，中性表情，纯色浅灰背景，无其他人物';
    }
    if (angleId === 'back') {
      return '完全背面视角（背对镜头，看不到脸），同一个人，发型、发色、身形、服装背面、配饰与正面一致，纯色浅灰背景，无其他人物';
    }
    return '';
  }
  if (kind === 'scene') {
    if (angleId === 'left') return '镜头转向左侧墙面/左侧方向的空镜，同一个地点，建筑结构、陈设、材质、光线与广角图一致，无人物';
    if (angleId === 'right') return '镜头转向右侧墙面/右侧方向的空镜，同一个地点，建筑结构、陈设、材质、光线与广角图一致，无人物';
    if (angleId === 'top') {
      /**
       * 俯视平面图不是"从上往下拍一张照片"，是**布局图**。
       * 说成前者的话，模型会给一个仰角很大的普通镜头，
       * 那既不能当俯拍参考，也没法当排位底图。
       */
      return '正俯视平面布局图（相机正对地面垂直向下），画出家具和陈设的位置关系，同一个地点，无人物，无透视变形';
    }
    return '';
  }
  return '';
}

/** 描述里出现这些词，就该换那个角度的参考图 */
const CHAR_HINTS = [
  { angle: 'back', re: /背对|背影|背后|转身(离开|走|跑)|从身后|背朝/ },
  { angle: 'side', re: /侧脸|侧身|侧面|侧对|并肩|对视(?!镜头)/ }
];
const SCENE_HINTS = [{ angle: 'top', re: /俯视|俯拍|航拍|鸟瞰|顶视/ }];

/**
 * 这一镜该用哪个角度的图。
 *
 * ── 为什么用关键词而不是问模型 ──
 *
 * 这件事每一镜都要判一次，问模型就是每一镜多一次调用、多一份钱、多一处失败点，
 * 而收益只是"背对"这几个词判得更准一点。关键词判错的代价也小：
 * 退回主图而已，和现在的行为一模一样，不会更差。
 *
 * ⚠ 判断只看**画面描述和运镜**，不看台词。台词里"他转身走了"是旁白在讲，
 * 画面上可能根本没这个动作。
 */
export function pickAngle(kind, shot, { available = [], hint = null } = {}) {
  /**
   * 排过位的话，**机位算出来的关系说了算**，关键词让路。
   *
   * 关键词只在没有机位信息时才是最优解。「他望着窗外」既可能是侧脸
   * 也可能是背影 —— 这靠读字是分不出来的，而机位一摆就是确定的。
   */
  if (hint && hint !== PRIMARY && available.includes(hint)) return hint;
  if (hint === PRIMARY) return PRIMARY;

  const text = `${shot?.description || ''} ${shot?.camera || ''} ${shot?.motion || ''}`;
  const hints = kind === 'scene' ? SCENE_HINTS : kind === 'char' ? CHAR_HINTS : [];
  for (const h of hints) {
    if (h.re.test(text) && available.includes(h.angle)) return h.angle;
  }
  return PRIMARY;
}

/** 这个变体已经有哪几个额外角度（有图的才算） */
export function availableOn(variant) {
  return (variant?.angles || []).filter((a) => a?.sheetPath).map((a) => a.id);
}

/** 取某个角度的那张图；主角度回落到变体自己的 sheet */
export function sheetOf(variant, angleId) {
  if (!variant) return null;
  if (!angleId || angleId === PRIMARY) {
    return variant.sheetPath || variant.sheetUrl
      ? { id: PRIMARY, sheetPath: variant.sheetPath || null, sheetUrl: variant.sheetUrl || null }
      : null;
  }
  return (variant.angles || []).find((a) => a.id === angleId) || null;
}

/** 就地补齐 angles 字段。和 normalizeItem 一样：读的时候补，不写迁移脚本 */
export function normalizeVariant(variant) {
  if (!variant || typeof variant !== 'object') return variant;
  if (!Array.isArray(variant.angles)) variant.angles = [];
  return variant;
}
