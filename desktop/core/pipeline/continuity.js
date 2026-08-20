/**
 * 镜间衔接。
 *
 * 一致性引擎解决的是"**这一镜**像不像"，这里解决的是"**上一镜到这一镜**接不接得上"。
 * 两件事经常被混为一谈，但失败的样子完全不同：
 *
 *   一致性坏了 → 第 7 镜的人换了张脸；
 *   衔接坏了   → 每一镜的脸都对，可是第 6 镜是黄昏、第 7 镜突然大中午，
 *                人在第 6 镜往右走出画，第 7 镜却从右边走进来（观众会觉得他掉头了）。
 *
 * 第二种更难发现，因为逐镜看每一张都没问题，只有连起来放才露馅 ——
 * 而那时候钱已经花完了。
 *
 * ── 为什么不是"全都接上" ──
 *
 * 最容易想到的做法是：把上一镜的末帧当成下一镜的首帧，一路传下去。
 * 这样确实"接得上"，但**整部片子会变成一个连续长镜头** —— 没有剪辑、没有机位变化，
 * 二十镜看下来像一条没剪过的素材。电影语言里，"接"和"切"是两件事，
 * 大部分镜位切换本来就该是硬切，只有环境和光线要连续。
 *
 * 所以这里把镜与镜的关系分成三种，各用各的手段：
 *
 *   new-scene（换场景）  完全不接。只靠场景基准图保证"还是这部片子"，
 *                        画面本来就该变。硬接反而会让转场变糊。
 *   cut（同场景换机位）  **默认**。环境、光线、天气、时间要连住，机位可以随便跳。
 *                        手段是提示词层面的约束 + 同一张场景基准图 + 不越轴。
 *   continuous（连续动作）动作不能断，比如"推门"接"进门"。
 *                        手段是尾帧衔接：这一镜的**末帧**直接锁成下一镜的首帧图。
 *
 * 默认给 cut 而不是 continuous 是刻意的：判断错的代价不对称。
 * 该切的地方接上了 → 整段失去剪辑感，只能重出；
 * 该接的地方切了   → 顶多是硬切一下，还能看。
 */

/** 镜与镜的三种关系 */
export const LINKS = ['new-scene', 'cut', 'continuous'];

export const LINK_LABELS = {
  'new-scene': '换场景',
  cut: '同场景换机位',
  continuous: '连续动作'
};

export const LINK_HINTS = {
  'new-scene': '和上一镜没有画面上的连续性，硬切。只保证还是同一部片子的质感',
  cut: '同一场景里换机位：光线、天气、环境要连住，机位可以跳',
  continuous: '动作不能断（推门→进门）。会把这一镜的末帧锁成下一镜的首帧'
};

/** 两个场景名算不算同一个地方。模型有时写"码头"有时写"渔港码头"。 */
export function sameScene(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 推断这一镜和上一镜是什么关系。
 *
 * 只在**没有明确指定**时才推断 —— 用户在界面上手选过的、或者拆分镜时模型自己标了的，
 * 一律以那个为准。推断出来的东西一旦盖掉人选的，界面就会出现"我明明选了却自己变回去"。
 */
export function deriveLink(shot, prev) {
  if (LINKS.includes(shot?.link)) return shot.link;
  if (!prev) return 'new-scene';
  if (!sameScene(prev.scene, shot?.scene)) return 'new-scene';
  return 'cut';
}

/** 给整条分镜表补上 link（不覆盖已有的） */
export function withLinks(shots = []) {
  const sorted = shots.slice().sort((a, b) => a.index - b.index);
  return sorted.map((s, i) => ({ ...s, link: deriveLink(s, i ? sorted[i - 1] : null) }));
}

/** 排好序的相邻两镜。章节不跨 —— 跨章的"上一镜"不是同一段戏。 */
export function neighbors(shots = [], shotId) {
  const sorted = shots.slice().sort((a, b) => a.index - b.index);
  const i = sorted.findIndex((s) => s.id === shotId);
  if (i === -1) return { prev: null, next: null, link: 'new-scene' };
  const sameChapter = (a, b) => (a?.chapterId || null) === (b?.chapterId || null);
  const prev = i > 0 && sameChapter(sorted[i - 1], sorted[i]) ? sorted[i - 1] : null;
  const next = i < sorted.length - 1 && sameChapter(sorted[i + 1], sorted[i]) ? sorted[i + 1] : null;
  return { prev, next, link: deriveLink(sorted[i], prev), nextLink: next ? deriveLink(next, sorted[i]) : null };
}

/** 一句话摘要，塞进提示词用。视频模型的提示词很短，不能把整段描述抄进去。 */
function brief(text, max = 34) {
  const one = String(text || '').replace(/\s+/g, '').split(/[。；;]/)[0] || '';
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 衔接约束，作为提示词的一部分发给视频模型。
 *
 * 这几句是**最便宜的衔接手段**：不多花一分钱、不多调一次接口，
 * 只是把"这一镜的上下文"告诉模型。没有它的话，模型只看得见一张图和一句描述，
 * 它根本不知道自己是一部片子里的第 7 镜，于是每一镜都从头起势 ——
 * 这就是"逐镜都对，连起来不像一部片子"的根因。
 */
export function continuityLines(shot, { prev, next, link, brief: short = false } = {}) {
  const lines = [];
  const rel = link || deriveLink(shot, prev);

  if (rel === 'continuous' && prev) {
    // 连续动作：不能重新起势，否则"推门→进门"会变成"推门→（重新站定）→进门"
    lines.push(`承接上一镜「${brief(prev.description)}」，从上一镜结束的状态继续，不要重新起势`);
  } else if (rel === 'cut' && prev) {
    // 越轴是连贯性里最常见也最刺眼的错：人物在上一镜往右走，这一镜就不能往左。
    // 这条永远要发 —— 它是首帧图管不了的事（图只有一格，看不出运动方向）。
    lines.push('保持与上一镜相同的运动方向与视线方向，不要越轴');
    // 同场景换机位：画面可以完全不同，但**不能换天**。
    // 精简模式下省掉 —— 首帧图本身就带着这一场的光线和天气，模型照着图走已经够了
    if (!short) lines.push('与上一镜同一场景，光线、天气、时间、环境陈设保持一致');
  }

  // 告诉它"要交到哪儿去"。少了这句，模型会把动作做完做满，
  // 结尾停在一个和下一镜完全接不上的状态上。
  // 精简模式下只在**下一镜要接着演**（连续动作）时才发：硬切的下一镜本来就可以另起，
  // 为它多花二三十字不划算。
  const nextRel = next ? deriveLink(next, shot) : null;
  if (next && rel !== 'new-scene' && (!short || nextRel === 'continuous')) {
    lines.push(`结尾停在能接上「${brief(next.description)}」的状态`);
  }

  return lines;
}

/**
 * 这一镜要不要把**下一镜的图**锁成末帧。
 *
 * 这是衔接里最硬的一招，也是唯一能真正做到"无缝"的：
 * 首帧是这一镜自己那张已经审过的图，末帧是下一镜那张已经审过的图 ——
 * 于是这一段片子从 A 长到 B，切到下一镜时画面**完全对齐**。
 *
 * 注意方向：是"拿下一镜的图当末帧"，不是"拿上一镜的末帧当这一镜的首帧"。
 * 后者会让这一镜不再忠于它自己那张审过的图，等于把一致性让给了衔接 ——
 * 两个都想要的话，只能走前者。
 *
 * 只在 continuous 时用：cut 的镜位是要跳的，锁了末帧等于不让它跳。
 */
export function shouldChainEndFrame(nextShot, nextLink, thisShot = null) {
  if (!nextShot?.imagePath || nextLink !== 'continuous') return false;
  /**
   * 跨场次绝不锁末帧。
   *
   * 这是"顺序反了"会造成的**唯一一处真实损失**：锁末帧的含义是
   * "这一段片子要长成下一镜那张图的样子"。跨了时间地点还这么锁，
   * 等于强行让二十年后那一镜画成二十年前 —— 而且任务是"成功"的，
   * 没有一处会报错。解析时已经把跨场次的 link 归一成 new-scene 了，
   * 这里是第二道：手改过的、老项目里存着的，都拦得住。
   */
  if (thisShot && Number(thisShot.segment || 1) !== Number(nextShot.segment || 1)) return false;
  return true;
}


/**
 * ═══════════════ 邻镜参考：把「链」改成「星」 ═══════════════
 *
 * 常见的想法是链式：第 1 镜的图当第 2 镜的参考，第 2 镜的当第 3 镜的，一路传下去。
 * 直觉上很对 —— 每一镜都和前一镜像，那全片就都像。
 *
 * **但它一定会漂。** 每一次生成都有损耗：色偏、细节丢失、压缩痕迹。
 * 第 3 镜参照的是已经漂过一次的第 2 镜，第 4 镜参照的是漂过两次的第 3 镜……
 * 到第 10 镜时，参照物本身已经面目全非，而且**回不去**——
 * 链条上没有任何一环记得原本长什么样。拿移动的东西当基准，就是这个结果。
 *
 * 换个拓扑就解决了：**同一场景里的每一镜，都参照这个场景的第一张成图**。
 *
 *     链：  1 → 2 → 3 → 4 → 5      误差累加 5 次
 *     星：  1 → 2, 1 → 3, 1 → 4    每一镜都只差 1 次，永不累积
 *
 * 效果上"每一镜都和邻镜像"照样成立（都像同一张，自然彼此也像），
 * 而误差是**常数**不是**累加**。代价只有一个：场景锚那张必须是好的 ——
 * 所以它同时也变成了唯一值得你回头审的那一张。
 *
 * 只有 continuous（动作不能断）才退回真正的链式：那时候要的是
 * "上一帧的下一瞬间"，参照场景锚没有意义。而 continuous 本来就是少数。
 */

/** 这一镜该拿哪一张已有的成图当"邻居参考" */
export function neighborRef(project, shot, { mode = 'scene-anchor' } = {}) {
  if (mode === 'off') return null;
  const shots = (project?.shots || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const at = shots.findIndex((s) => s.id === shot.id);
  if (at <= 0) return null;

  const link = shot.link || deriveLink(shot, shots[at - 1]);
  // 换场景就断链：画面本来就该变，硬拿上一场的图当参考只会把新场景污染掉
  if (link === 'new-scene') return null;

  const prev = shots[at - 1];

  /**
   * 场次边界比场景名更靠得住，所以它也要断链。
   *
   * 光比场景名会漏掉一种最坑的情况：**同一个地方，隔了很久**。
   * "二十年前的办公室"和"今天的办公室"很可能挂着同一个场景名，
   * 于是今天那一镜会拿二十年前那张当参考 —— 人、光、陈设全被带回去，
   * 而且不报任何错。场次是按"时间跳了或地点换了"划的，正好拦住它。
   */
  if (Number(prev.segment || 1) !== Number(shot.segment || 1)) return null;

  /**
   * 连续动作是唯一该用真链式的地方 —— 要的是"上一帧的下一瞬间"，
   * 场景锚给不了这个。这一条本来就少，累积不了几次。
   */
  if (link === 'continuous') {
    return prev?.imagePath ? { path: prev.imagePath, kind: 'prev', label: `接·第${prev.index}镜` } : null;
  }
  if (mode === 'prev') {
    return prev?.imagePath ? { path: prev.imagePath, kind: 'prev', label: `邻·第${prev.index}镜` } : null;
  }

  /**
   * 场景锚：**从这一镜往回找，直到场景变了为止**，取那一段里最早的一张成图。
   * 往回找而不是从头找，是因为同一个场景可能在片子里出现两次
   * （码头 → 值班室 → 码头），第二次那段该有自己的锚 ——
   * 拿二十镜之前那张当参考，光线和时间早就不是一回事了。
   */
  let anchor = null;
  for (let i = at - 1; i >= 0; i -= 1) {
    const s = shots[i];
    if (Number(s.segment || 1) !== Number(shot.segment || 1)) break;
    if (!sameScene(s.scene, shot.scene)) break;
    if (s.imagePath) anchor = s;
  }
  return anchor ? { path: anchor.imagePath, kind: 'scene-anchor', label: `锚·第${anchor.index}镜` } : null;
}
