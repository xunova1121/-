/**
 * 转场 —— 两镜之间怎么切过去。
 *
 * ════════ 先把最重要的一句说在前面 ════════
 *
 * **顶级的转场衔接，九成不在这个文件里。**
 *
 * 让接缝看不出来的，是分镜本身怎么设计的：在动作进行到一半时切、
 * 前后镜的视线和走位方向对得上、上一镜出画下一镜入画。
 * 这些都发生在「拆分镜」那一步（见 studio.js 的分镜铁律），
 * 不是靠后期叠一层特效补出来的。
 *
 * 真正的行家几乎只用**硬切**。满屏的叠化恰恰是最典型的业余标志 ——
 * 它不会让片子更顺，只会让人看不清刚才发生了什么。
 * 所以这个模块的默认值是 cut，而且提示词里明确告诉模型"绝大多数镜都该是 cut"。
 *
 * 这里做的是剩下那一成：**真的换了时间、换了地点**的时候，
 * 观众需要一个明确的信号说"这里断了"。那时候黑场或叠化才有用。
 *
 * ════════ 两种效果，代价完全不同 ════════
 *
 *   fade（黑场）     淡出到黑 → 从黑淡入。**不吃掉任何时长** ——
 *                    它是在原有画面上做的，总长一秒不差。
 *   dissolve（叠化） 两段画面重叠着渐变。**必然吃掉重叠的那段时间** ——
 *                    这是叠化的定义决定的，没有办法绕开。
 *
 * 第二条那个"吃掉时间"是个真会出事的细节：全片短了半秒，
 * 而配音和字幕是按**绝对时间**摆的，后面每一句都会往后错。
 * 所以 overlapOf() 必须被时间轴那一层用上（timelineOf），
 * 三者用同一个数，才不会各算各的。
 */

/** 叠化重叠多久。太长会糊成一团，太短看不出来 */
export const DISSOLVE_SECONDS = 0.5;

/** 黑场淡入淡出各多久。两端合计 0.8 秒，正好是"断了一下"的感觉 */
export const FADE_SECONDS = 0.4;

export const KINDS = ['cut', 'fade', 'dissolve'];

/** 界面上怎么写 */
export const LABELS = {
  cut: '硬切（默认）',
  fade: '黑场（换时间换地点）',
  dissolve: '叠化（时间流逝）'
};

/**
 * ════════ 剪辑台上那一排"更多转场" ════════
 *
 * 上面那三个是**模型能选的**（见 segments.js：分镜解析时强制归一到这三个）。
 * 下面这些是**人在剪辑台上手选的** —— 模型不该有权选它们，
 * 理由和上面那段一样：满屏推拉划像是业余标志，而模型最爱干这个。
 *
 * ⚠ 两份清单必须分开。把它们合成一份的话，模型输出里蹦出一个
 * "pixelize" 就会被当成合法值原样收下，然后二十镜的片子里冒出一处马赛克 ——
 * 而没有任何人做过这个决定。
 *
 * ── 实现上只有三类 ──
 *
 *   mode: 'none'    什么都不做（硬切）
 *   mode: 'black'   在原片上做淡出/淡入。**不吃时长**
 *   mode: 'xfade'   两段重叠着换。**必然吃掉重叠的那段时间**（见文件开头）
 *
 * xfade 那一栏是 FFmpeg `xfade` 滤镜的 transition 名。老版本 FFmpeg 认得的
 * 名字更少 —— 所以合成那一层必须能"这一处做不出来就退回叠化"，
 * 而不是让一个不认识的名字把整部片子的转场全带崩。
 */
export const CATALOG = [
  { id: 'cut', label: '硬切（默认）', mode: 'none', xfade: null, why: '九成的镜头之间都该是这个' },
  { id: 'fade', label: '黑场', mode: 'black', xfade: null, why: '换时间、换地点' },
  { id: 'dissolve', label: '叠化', mode: 'xfade', xfade: 'fade', why: '时间流逝' },
  { id: 'fadeblack', label: '闪黑', mode: 'xfade', xfade: 'fadeblack', why: '比黑场急，一下就过去' },
  { id: 'fadewhite', label: '闪白', mode: 'xfade', xfade: 'fadewhite', why: '回忆、爆闪、醒来' },
  { id: 'slideleft', label: '左推', mode: 'xfade', xfade: 'slideleft', why: '同场景换角度' },
  { id: 'slideright', label: '右推', mode: 'xfade', xfade: 'slideright', why: '同场景换角度' },
  { id: 'slideup', label: '上推', mode: 'xfade', xfade: 'slideup', why: '换段落' },
  { id: 'slidedown', label: '下推', mode: 'xfade', xfade: 'slidedown', why: '换段落' },
  { id: 'wipeleft', label: '左划', mode: 'xfade', xfade: 'wipeleft', why: '并置两件同时发生的事' },
  { id: 'wiperight', label: '右划', mode: 'xfade', xfade: 'wiperight', why: '并置两件同时发生的事' },
  { id: 'smoothleft', label: '柔划左', mode: 'xfade', xfade: 'smoothleft', why: '比硬划像温和' },
  { id: 'smoothright', label: '柔划右', mode: 'xfade', xfade: 'smoothright', why: '比硬划像温和' },
  { id: 'circleopen', label: '圆开', mode: 'xfade', xfade: 'circleopen', why: '进入某人的视角' },
  { id: 'circleclose', label: '圆收', mode: 'xfade', xfade: 'circleclose', why: '一段结束，收束到一点' },
  { id: 'pixelize', label: '马赛克', mode: 'xfade', xfade: 'pixelize', why: '穿越、数字感' },
  { id: 'radial', label: '扫转', mode: 'xfade', xfade: 'radial', why: '时间跳跃' },
  { id: 'zoomin', label: '推近', mode: 'xfade', xfade: 'zoomin', why: '往细节里钻' },
  { id: 'hblur', label: '横向模糊', mode: 'xfade', xfade: 'hblur', why: '甩镜、失神' }
];

/** 剪辑台上人能选的全部转场（含上面那三个） */
export const ALL_KINDS = CATALOG.map((t) => t.id);

const BY_ID = new Map(CATALOG.map((t) => [t.id, t]));

/** 查一条转场的定义。不认识的一律当硬切 */
export function defOf(kind) {
  return BY_ID.get(kind) || BY_ID.get('cut');
}

/** 不认识的值一律当硬切。模型瞎编的转场名不该悄悄变成别的效果 */
export function kindOf(shot) {
  const k = shot?.transition;
  return ALL_KINDS.includes(k) ? k : 'cut';
}

/** 这个转场要用 xfade 做吗（要的话就会吃掉时长） */
export function xfadeOf(kind) {
  return defOf(kind).xfade;
}

/**
 * 这一种转场吃掉多少秒。
 *
 * 和 overlapOf(shot) 是同一个数，只是入口不同：剪辑台把转场记在
 * **剪辑决定**里（edit.clips[id].trans），那时手上只有一个字符串，没有 shot。
 */
export function overlapOfKind(kind) {
  return defOf(kind).mode === 'xfade' ? DISSOLVE_SECONDS : 0;
}

/**
 * 进入这一镜要吃掉多少秒。
 *
 * 只有叠化会吃 —— 黑场是原地做的，硬切什么都不做。
 * 这个数是时间轴、字幕、合成三处共用的，**改这里就三处一起改**，
 * 这正是把它单独拎出来的原因：三处各写一个 0.5，早晚会有一处忘了改。
 */
export function overlapOf(shot) {
  return overlapOfKind(kindOf(shot));
}

/** 整部片子被叠化吃掉的总时长。第一镜的转场是片头，不吃时间 */
export function totalOverlap(shots = []) {
  return shots.slice(1).reduce((sum, s) => sum + overlapOf(s), 0);
}

/** 有没有需要动手的转场。没有的话合成走原来那条不重编码的快路 */
export function anyEffect(shots = []) {
  return shots.slice(1).some((s) => kindOf(s) !== 'cut');
}
