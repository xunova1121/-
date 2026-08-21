/**
 * 时长控制。
 *
 * 「短片多长」这件事里藏着三个不同的数，混在一起就永远对不上：
 *
 *   目标时长  你想要的，比如"一分钟"。是输入，不是结果。
 *   计划时长  分镜表里每镜时长之和。模型拆分镜时定的。
 *   实际时长  成片真正多长。由**厂商的量化档位**决定。
 *
 * 第三个是最容易翻车的：视频模型不接受任意秒数。
 * Seedance / 可灵只给 5s、10s，Vidu 是 4s、8s，万相基本只有 5s。
 * 你请求 4 秒，它给你 5 秒 —— 8 个镜头就凭空多出 8 秒。
 *
 * 早期版本在这里只写了 `Math.min(Math.max(d,3),5)`：既不对齐档位，
 * 也不告诉任何人夹过。于是分镜表显示 32 秒，成片 40 秒，
 * 而界面从头到尾都说 32 秒。这个模块就是来把这三个数分开算、分开显示的。
 */

/** 各家没写明档位时的兜底：多数图生视频以 5 秒为基本单位 */
const DEFAULT_DURATIONS = [5];

export function allowedDurations(provider, modelId) {
  const model = (provider?.models || []).find((m) => m.id === modelId);
  if (model?.durations?.length) return [...model.durations].sort((a, b) => a - b);
  // 同一家其他视频模型的档位通常一致，拿来当近似
  const sibling = (provider?.models || []).find((m) => m.durations?.length);
  return sibling ? [...sibling.durations].sort((a, b) => a - b) : DEFAULT_DURATIONS;
}

/**
 * 把想要的时长对齐到合法档位。
 *
 * 默认「向上取」而不是「取最近」：宁可多出来一点，也不要少 ——
 * 少了会把动作或台词切掉，多出来的部分合成时还能裁。
 */
export function alignDuration(requested, allowed = DEFAULT_DURATIONS, { mode = 'up' } = {}) {
  const want = Number(requested) || allowed[0];
  const options = allowed.length ? allowed : DEFAULT_DURATIONS;

  if (mode === 'nearest') {
    return options.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), options[0]);
  }
  return options.find((d) => d >= want) ?? options[options.length - 1];
}

/**
 * 这句台词大概要念多久（秒）。
 *
 * ── 为什么必须在**拆分镜那一步**就估 ──
 *
 * 原来只有合成那一步会发现"台词比镜头长"，而那时候图和视频的钱已经全花完了。
 * 补救只有两条：把镜头拉长（要重出这一镜的视频），或者把台词改短（要重配音）。
 * 两条都是重来一遍。
 *
 * 而这件事**在拆分镜的时候就完全算得出来** —— 台词就在手上，几个字数一乘就知道。
 * 一个 12 个字的句子塞进 3 秒的镜头，念不完是必然的，不需要等到出片才发现。
 *
 * ── 这个估法有多准 ──
 *
 * 中文 TTS 常速大约每秒 4~5 个字。这里取 4.5，再加标点停顿和首尾的气口。
 * 它不可能准到零点几秒，也不需要 —— 我们要判的是"3 秒够不够念 12 个字"，
 * 那是差一倍的量级，估到 ±20% 就完全够用。
 *
 * ⚠ 宁可估长。估短了会把台词切掉（最刺耳的一种错），估长了顶多多几秒画面。
 */
const CHARS_PER_SEC = 4.5;
const PAUSE_PER_PUNCT = 0.22;
/** 开口前和收尾的气口。TTS 出来的音频两头本来就带一点静音 */
const BREATH = 0.6;

export function speechSeconds(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;

  // 标点单独算停顿，不计进字数 —— 逗号句号本身不发音，但它实实在在占时间
  const puncts = (raw.match(/[，,。.！!？?；;：:、…—]/g) || []).length;
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  // 英文按词算：一个词平均约 0.35 秒，和中文一个字的时长不是一回事
  const words = (raw.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;

  const spoken = cjk / CHARS_PER_SEC + words * 0.35;
  return Number((spoken + puncts * PAUSE_PER_PUNCT + BREATH).toFixed(1));
}

/**
 * 这一镜的时长够不够念完台词。
 *
 * 留 0.4 秒余量：估算本来就有误差，而且台词紧贴着镜头结尾收也很难看 ——
 * 话音刚落画面就切走，观众会觉得被打断。
 */
export const SPEECH_HEADROOM = 0.4;

export function fitsDialogue(shot) {
  const need = speechSeconds(shot?.dialogue);
  const have = Number(shot?.duration) || 0;
  return { need, have, ok: need === 0 || have >= need + SPEECH_HEADROOM };
}

/** 念得完这句话，至少要多少秒 */
export function secondsForDialogue(shot) {
  const need = speechSeconds(shot?.dialogue);
  return need ? Number((need + SPEECH_HEADROOM).toFixed(1)) : 0;
}

/** 常见的成片长度，做成预设省得手填 */
export const DURATION_PRESETS = [
  { seconds: 15, label: '15 秒', note: '信息流广告' },
  { seconds: 30, label: '30 秒', note: '预告片' },
  { seconds: 60, label: '1 分钟', note: '短视频主流' },
  { seconds: 120, label: '2 分钟', note: '短剧单集' },
  { seconds: 180, label: '3 分钟', note: '完整小故事' },
  { seconds: 300, label: '5 分钟', note: '长一点的叙事' }
];

/**
 * 由目标时长反推该拆多少个镜头。
 *
 * 人想的是"我要 60 秒"，不是"我要 13 个镜头"。
 * 这里按平均镜长折算，并留出让模型调节奏的余地 ——
 * 均分每镜看着整齐，剪出来其实很呆板。
 */
export function planShotCount(targetSeconds, { avgShotSeconds = 4.5, min = 2, max = 200 } = {}) {
  const n = Math.round((Number(targetSeconds) || 60) / avgShotSeconds);
  return Math.max(min, Math.min(max, n));
}

/** 一个镜头到底会占多长：优先用真实值，没有就用对齐后的计划值 */
export function shotSeconds(shot) {
  return Number(shot.actualDuration) || Number(shot.duration) || 0;
}

/**
 * 把项目的三个时长算清楚。
 * 界面上要把它们分开摆 —— 差在哪、差多少，一眼看到。
 */
export function summarize(project, { policy = 'trim' } = {}) {
  const shots = project?.shots || [];
  const planned = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const generated = shots.reduce((sum, s) => sum + shotSeconds(s), 0);
  // 裁剪模式下成片按计划时长走；保留模式下按模型实际给的走
  const withVideo = shots.filter((s) => s.videoPath);
  const finalSeconds =
    policy === 'trim'
      ? withVideo.reduce((sum, s) => sum + (Number(s.duration) || 0), 0)
      : withVideo.reduce((sum, s) => sum + shotSeconds(s), 0);

  const target = Number(project?.targetDuration) || 0;
  return {
    target,
    planned: round1(planned),
    generated: round1(generated),
    final: round1(finalSeconds),
    // 计划和实际差多少 —— 这就是厂商档位吃掉的那部分
    quantizationOverhead: round1(generated - planned),
    delta: target ? round1(planned - target) : null,
    withinTolerance: target ? Math.abs(planned - target) <= Math.max(3, target * 0.1) : true,
    shots: shots.length,
    videoReady: withVideo.length
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function fmtSeconds(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
}

/**
 * 按目标时长把每镜时长重新分配。
 *
 * 不是均分：保留模型原本定的节奏比例（谁长谁短是有叙事道理的），
 * 只是整体缩放，再夹到合法区间。这样 60 秒改成 45 秒，
 * 快镜还是快镜，长镜还是长镜。
 */
export function rescale(shots, targetSeconds, { min = 3, max = 10 } = {}) {
  const base = shots.map((s) => Number(s.duration) || 4);
  const total = base.reduce((a, b) => a + b, 0);
  if (!total || !targetSeconds) return shots.map((s) => ({ ...s }));

  // 目标本身就超出「镜数 × 上下限」能表达的范围时，只能贴到那个边界
  const floor = shots.length * min;
  const ceil = shots.length * max;
  const goal = Math.max(floor, Math.min(ceil, targetSeconds));

  // 先按比例缩放，再把被上下限夹掉的余量分给还有余地的镜头。
  // 只缩放不重分配的话，一旦有镜头顶到上限，总时长就永远差一截 ——
  // [3,6,3] 放大到 24 秒会得到 [6,10,6]=22，差的那 2 秒凭空消失。
  let value = base.map((d) => (d / total) * goal);
  for (let pass = 0; pass < 8; pass++) {
    const clamped = value.map((d) => Math.max(min, Math.min(max, d)));
    const diff = goal - clamped.reduce((a, b) => a + b, 0);
    if (Math.abs(diff) < 0.05) {
      value = clamped;
      break;
    }
    // 还能往需要的方向动的镜头，按当前权重分摊差额
    const movable = clamped.map((d, i) => (diff > 0 ? d < max : d > min));
    const weight = clamped.reduce((sum, d, i) => sum + (movable[i] ? d : 0), 0);
    if (!weight) {
      value = clamped;
      break;
    }
    value = clamped.map((d, i) => (movable[i] ? d + (diff * d) / weight : d));
  }

  return shots.map((s, i) => ({
    ...s,
    duration: Math.round(Math.max(min, Math.min(max, value[i])) * 10) / 10
  }));
}
