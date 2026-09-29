/**
 * 镜头分级 —— 贵模型只用在看得出差别的地方。
 *
 * ── 为什么这件事值钱 ──
 *
 * 视频那一步是整条流水线最大的一笔开销，而且是**按镜计费**的。
 * 但一部片子里，各镜头对模型的要求差得很远：
 *
 *   主角面部特写   观众盯着脸看好几秒，模型差一点立刻露馅
 *   一般叙事镜头   中景、有动作，中档模型足够
 *   空镜 / 远景    云、海、街景、雨。没有人脸，便宜模型和贵模型看不出差别
 *
 * 全片一律用最贵那个，等于为看不出差别的地方付全价。一部 20 镜的片子里
 * 空镜和过渡镜常常占三到四成 —— 这部分的钱是白花的。
 *
 * ── 为什么是自动判定 + 可手改，而不是纯手动 ──
 *
 * 纯手动意味着每部片子都要人过一遍二十镜，没人会长期坚持做这件事，
 * 于是这个功能形同虚设。而纯自动会有判错的时候，判错在"该贵的用了便宜的"
 * 那一侧是要命的。所以：**自动给一个判断，判错的那几镜你手动改掉**，
 * 而且判断依据是看得懂的（景别 + 有没有人），不是一个黑盒打分。
 *
 * ── 默认全都跟随主路由 ──
 *
 * 不配就是现在的行为，一模一样。这一层是**选配**：只有你明确给某一档
 * 指定了别的模型，它才开始起作用。默默换掉用户选的模型是不能接受的。
 */

export const TIERS = ['high', 'normal', 'low'];

export const TIER_LABELS = {
  high: '关键镜（主角特写）',
  normal: '一般叙事镜',
  low: '空镜 / 远景'
};

export const TIER_HINTS = {
  high: '观众盯着脸看好几秒，模型差一点立刻露馅。这一档值得上最好的',
  normal: '中景、有动作、有台词。中档模型足够',
  low: '没有人脸的空镜、远景、过渡。便宜模型和贵模型看不出差别 —— 这一档最省钱'
};

/** 有人脸、而且脸占画面比重大的景别 */
const CLOSE = ['大特写', '特写', '近景', '中近景'];
/** 人在画面里很小，或者压根没人 */
const WIDE = ['全景', '远景', '大远景', '航拍'];

/**
 * 这一镜属于哪一档。
 *
 * 判断依据刻意只用**两样看得懂的东西**：景别 + 这一镜有没有角色。
 * 不用模型打分，也不解析描述里的形容词 —— 那样判错时没人说得清为什么，
 * 而"说得清为什么"在这里比"多判对几镜"重要：你得能一眼看出该不该手动改它。
 */
export function tierOf(shot = {}) {
  // 人手指定过就听人的。自动判定永远不该覆盖手选
  if (TIERS.includes(shot.tier)) return shot.tier;

  const cast = (shot.characters || []).length;
  const camera = String(shot.camera || '');

  // 没有人的镜头一律最低档 —— 云、海、街景，便宜模型完全够
  if (!cast) return 'low';
  // 有人但拉得很远，脸只有几个像素，贵模型花在这儿是浪费
  if (WIDE.some((c) => camera.includes(c))) return 'low';
  // 有人 + 近景 = 观众正盯着脸看
  if (CLOSE.some((c) => camera.includes(c))) return 'high';
  return 'normal';
}

/** 为什么判成这一档 —— 界面上要说得出来，不然用户不知道该不该改它 */
export function reasonFor(shot = {}) {
  if (TIERS.includes(shot.tier)) return '你手动指定的';
  const cast = (shot.characters || []).length;
  const camera = String(shot.camera || '');
  if (!cast) return '这一镜没有角色出场';
  if (WIDE.some((c) => camera.includes(c))) return `${camera}：人在画面里很小`;
  if (CLOSE.some((c) => camera.includes(c))) return `${camera} + 有角色：观众会盯着脸看`;
  return '有角色，中等景别';
}

/**
 * 这一档该用哪家哪个模型。
 *
 * **没配就返回 null，调用方退回主路由** —— 不配等于现在的行为，一模一样。
 * 默默换掉用户在设置里选的模型是不能接受的，哪怕是"为你省钱"。
 */
export function routeFor(tier, tiersConfig = {}) {
  const t = TIERS.includes(tier) ? tier : 'normal';
  const cfg = tiersConfig?.[t];
  if (!cfg?.provider || !cfg?.model) return null;
  return { provider: cfg.provider, model: cfg.model };
}

/**
 * 一部片子按档位分下来是什么样。
 *
 * 界面上要先给这个，人才判断得出"值不值得配"—— 如果一部片子里
 * 低档只有一镜，配这一层就是白折腾。
 */
export function summarize(shots = []) {
  const out = { high: 0, normal: 0, low: 0, total: shots.length };
  for (const s of shots) out[tierOf(s)] += 1;
  return out;
}
