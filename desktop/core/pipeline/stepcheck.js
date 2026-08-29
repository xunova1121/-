/**
 * ══════════ 开跑之前，先说清楚这一步会烧掉什么 ══════════
 *
 * ── 这个模块存在的理由 ──
 *
 * 这个应用里每一步都**真花钱、真花时间**：十几张图几分钟几块钱，
 * 一批视频十几分钟几十块。而绝大多数返工的原因，在按下「开始」之前
 * 就已经明明白白摆在数据里了 —— 没排位、没选技法卡、台词根本念不完、
 * 首帧图是照旧描述出的。
 *
 * 这些检查**本来就都有**（shotlint、duration、previz、bibleReadiness），
 * 只是散在四处，而且没有一个卡在"开跑之前"这个唯一有用的时刻。
 * 等图出完再告诉你"这 7 镜没选技法卡"，那句话已经不值钱了 ——
 * 改一次要重花一遍钱。
 *
 * ── 一条贯穿全篇的原则：别问"要不要"，要说"不改的代价是多少" ──
 *
 * "要不要标注动作？"这种提示，弹三次之后就没人看了 —— 它没给任何
 * 判断依据，只是把决定推回给用户。有用的是把代价摆出来：
 *
 *   有 7 镜一张技法卡都没选 —— 出来多半是站着不动的定妆照。
 *   现在改免费；出完再改要重花 ¥8.4。
 *
 * 所以每一条都必须回答三件事：**是什么、会怎样、怎么改**。
 * 缺"会怎样"的提示不如不做：它只会训练用户无视所有提示。
 *
 * ── 分级：拦 / 提醒 / 顺嘴一提 ──
 *
 *   blocker  跑下去几乎一定要重来（没出图就出视频）
 *   warn     跑得下去，但结果多半不是你要的（没排位、没技法卡）
 *   tip      可做可不做，只在清单里占一行，不拦任何东西
 *
 * ⚠ **分级一旦膨胀，整个功能就废了。**把"可以更好"的东西标成 warn，
 * 用户看到的就是一片黄，然后学会整块跳过 —— 连真正的 blocker 一起跳过。
 * 拿不准的一律往下降一级。
 */

import * as shotlint from './shotlint.js';
import * as duration from '../duration.js';
import * as previz from './previz.js';

/** 这一步会碰哪些镜头。和 estimate.pendingShots 一个口径，别各算各的 */
function targetsOf(shots, stage, regenerate) {
  const has = {
    assets: (s) => Boolean(s.imagePath),
    video: (s) => Boolean(s.videoPath),
    voice: (s) => Boolean(s.voicePath)
  }[stage];
  if (!has) return shots;
  return shots.filter((s) => regenerate || !has(s));
}

const idx = (list) => list.map((s) => s.index).filter((n) => Number.isFinite(n));

/**
 * 出图之前。
 *
 * ⚠ 这里**不判断"描述里有没有动作"**。
 *
 * 想过用动词表去猜，放弃了：中文里"他站在门口"和"他推开门"在词法上
 * 差别很小，而猜错的代价是每一份分镜表都红一片、然后没人再看这个清单。
 * 改成报**事实**：这一镜一张技法卡都没选。这是数据里明明白白的东西，
 * 不需要猜，而且它恰好就是"出来是不是定妆照"最强的那个信号。
 */
function forAssets(project, shots) {
  const out = [];
  const noSkill = shots.filter((s) => !(s.skills || []).length);
  if (noSkill.length) {
    out.push({
      id: 'no-skill',
      level: 'warn',
      what: `${noSkill.length} 镜一张技法卡都没选`,
      why: '技法卡是把"这一镜到底在演什么"说给模型听的地方。一张都没有时，'
        + '模型只能照着静态描述画 —— 出来多半是站着不动的定妆照，'
        + '人对了、衣服对了，就是没有戏。',
      fix: '在镜头卡上点「改这一镜」，动作那一组挑一张。同一场戏的几镜可以选同一张。',
      shots: idx(noSkill)
    });
  }

  const noStage = shots.filter((s) => !s.stage?.cam);
  if (noStage.length) {
    out.push({
      id: 'no-stage',
      level: 'warn',
      what: `${noStage.length} 镜没在预演台排位`,
      why: '没排位就没有机位、没有景别、没有轴线 —— 构图完全由文字决定，'
        + '同一场戏的几镜很容易各画各的。预演台拼的构图底图也发不出去（它需要排位）。',
      fix: '镜头卡上点「预演台」，把人和机位拖到位，再拼一张底图。',
      shots: idx(noStage)
    });
  }

  /**
   * 排了位、底图却是旧的 —— 比没排位更值得说。
   * 人已经付出了排位的工夫，而那份工夫**一点没进到图里**。
   */
  const staleFrame = shots.filter((s) => s.stage?.cam && s.blockFramePath
    && s.blockFrameStamp !== undefined
    && s.blockFrameStamp !== stampOf(s.stage));
  if (staleFrame.length) {
    out.push({
      id: 'stale-blockframe',
      level: 'warn',
      what: `${staleFrame.length} 镜排位改过，但构图底图还是老那张`,
      why: '过期的底图不会被发出去（发了会按老位置构图）。也就是说，'
        + '你改过的那些排位，这一次一点都不会生效。',
      fix: '去预演台点一下「重拼底图」。',
      shots: idx(staleFrame)
    });
  }

  /**
   * ⚠ "排了位但没拼底图"这条**只在你已经用过这个功能时才说**。
   *
   * 底图是可选的。对一个从没拼过底图的项目，这条会在**每一个**排过位的
   * 镜头上常驻 —— 一行永远消不掉的黄字。那不是提示，是广告：
   * 它不报告任何异常，只是在推销一个功能。
   * 而永远消不掉的提醒会被当成噪音，连带着旁边真正要紧的那条一起被无视。
   *
   * 自检里那条"干净的项目上一条都不报"当场把它抓出来了 ——
   * 我写那条断言正是为了防这种事，结果先防到了自己头上。
   *
   * 项目里**别处已经拼过**的话就不一样了：那说明你在用这个功能，
   * 而这几镜漏了 —— 那是一处真的不一致，值得说一句。
   */
  const adopted = (project.shots || []).some((s) => s.blockFramePath);
  const posed = adopted ? shots.filter((s) => s.stage?.cam && !s.blockFramePath) : [];
  if (posed.length) {
    out.push({
      id: 'no-blockframe',
      level: 'tip',
      what: `${posed.length} 镜排了位但没拼构图底图（别的镜头拼了）`,
      why: '排位只有拼成底图发出去才会影响画面。这几镜的排位这一次不会生效，'
        + '而同一场戏里别的镜头会 —— 构图基准两套，接起来会别扭。',
      fix: '预演台里点「拼一张底图」。',
      shots: idx(posed)
    });
  }

  return out.concat(fromLint(project, shots));
}

/** 排位指纹。和 blockframe.stageStamp 同一套算法 —— 这里不 import 它是为了不成环 */
function stampOf(stage) {
  const st = previz.normalizeStage(stage);
  if (!st) return '';
  const n = (v) => Number(v || 0).toFixed(2);
  return [
    `c${n(st.cam.x)},${n(st.cam.y)},${n(st.cam.height)},${n(st.cam.lens)}`,
    ...st.subjects.map((s) => `s${s.name}:${n(s.x)},${n(s.y)}`),
    ...st.marks.map((m) => (m.far ? `f${m.name}:${n(m.deg)}` : `m${m.name}:${n(m.x)},${n(m.y)}`))
  ].join('|');
}

/**
 * 分镜体检里那些**高危**项，汇总成一条。
 *
 * ⚠ 只取 high。把每一条中低危都摆进来的话，这份清单会有二十行，
 * 而二十行的清单等于零行 —— 没人会读完，然后连最上面那条也一起跳过。
 * 中低危留在镜头卡上就地显示，那儿才是改它的地方。
 */
function fromLint(project, shots) {
  const res = shotlint.lintShots(shots, { bible: project.bible });
  const high = [];
  for (const r of res || []) {
    for (const it of r.issues || []) {
      if (it.severity === 'high') high.push({ index: r.index, it });
    }
  }
  if (!high.length) return [];
  const byKind = new Map();
  for (const { index, it } of high) {
    if (!byKind.has(it.kind)) byKind.set(it.kind, { it, shots: [] });
    byKind.get(it.kind).shots.push(index);
  }
  return [...byKind.values()].map(({ it, shots: where }) => ({
    id: `lint-${it.kind}`,
    level: 'warn',
    what: `${where.length} 镜：${it.what}`,
    why: it.why,
    fix: it.fix,
    shots: where
  }));
}

/** 出视频之前 */
function forVideo(project, shots) {
  const out = [];

  /**
   * 还没出图就出视频 —— 这条是 blocker。
   *
   * 没有首帧图时视频完全由文字生成，人脸、服装、场景全部重新发挥，
   * 而这一步是全流程里最贵的。跑下去几乎一定要重来。
   */
  const noImage = shots.filter((s) => !s.imagePath);
  if (noImage.length) {
    out.push({
      id: 'no-first-frame',
      level: 'blocker',
      what: `${noImage.length} 镜还没有分镜图`,
      why: '没有首帧图，这一段视频的人脸、服装、场景全靠文字重新发挥 —— '
        + '和别的镜头接不上。而出视频是全流程里最贵的一步，'
        + '这几镜跑出来几乎一定要重做。',
      fix: '先回「镜头出图」把这几镜出了，再回来。',
      shots: idx(noImage)
    });
  }

  /**
   * 首帧图比描述旧 —— 提示词和首帧图在打架，而且**两边都是我们自己给的**。
   */
  const stale = shots.filter((s) => {
    const edited = Date.parse(s.editedAt || 0) || 0;
    const imaged = Date.parse(s.imageAt || 0) || 0;
    return s.imagePath && edited && imaged && edited > imaged;
  });
  if (stale.length) {
    out.push({
      id: 'stale-frame',
      level: 'warn',
      what: `${stale.length} 镜的描述改过，但图还是照旧描述出的`,
      why: '首帧图是旧画面、提示词是新描述，两边直接打架 —— '
        + '模型只能挑一边听，挑哪边你控制不了。',
      fix: '先把这几镜的图重出一遍，再出视频。',
      shots: idx(stale)
    });
  }

  const noSkill = shots.filter((s) => !(s.skills || []).length);
  if (noSkill.length) {
    out.push({
      id: 'no-skill-video',
      level: 'warn',
      what: `${noSkill.length} 镜没选技法卡`,
      why: '运镜和动作那两组卡是**只对视频生效**的（出图那步根本不读它们）。'
        + '一张都不选的话，这一段多半是一个几乎静止的画面在轻微飘动。',
      fix: '镜头卡上点「改这一镜」，运镜和动作各挑一张。',
      shots: idx(noSkill)
    });
  }

  /**
   * 台词念不完。
   *
   * ⚠ 这条必须在**出视频之前**说。视频时长一旦定死，台词要么被截断、
   * 要么整段加速，两种都难听，而且要重出这一段视频才能改。
   */
  const tooLong = shots.filter((s) => {
    const fit = duration.fitsDialogue(s);
    return fit && fit.ok === false;
  });
  if (tooLong.length) {
    out.push({
      id: 'dialogue-overflow',
      level: 'warn',
      what: `${tooLong.length} 镜的台词在这个时长里念不完`,
      why: '视频时长定死之后，台词要么被截断、要么整段加速 —— '
        + '两种都难听，而且要重出这一段视频才能改。',
      fix: '把这几镜的时长加一点，或者把台词删短。',
      shots: idx(tooLong)
    });
  }

  return out;
}

/** 配音之前 */
function forVoice(project, shots) {
  const out = [];
  const noSpeaker = shots.filter((s) => String(s.dialogue || '').trim() && !String(s.speaker || '').trim());
  if (noSpeaker.length) {
    out.push({
      id: 'no-speaker',
      level: 'warn',
      what: `${noSpeaker.length} 镜有台词但没说是谁在说`,
      why: '不知道是谁说的，就只能用默认音色 —— 全片所有人一个声音。',
      fix: '镜头卡上「说话人」那一栏填上，或者用「自动认说话人」。',
      shots: idx(noSpeaker)
    });
  }
  const noVoice = (project.bible?.characters || []).filter((c) => !c.voice);
  if (noVoice.length) {
    out.push({
      id: 'no-voice',
      level: 'tip',
      what: `${noVoice.length} 个角色还没分配音色`,
      why: '没分配的会落到默认音色上，几个角色听起来是同一个人。',
      fix: '「配音」那一步点「分配音色」。',
      shots: []
    });
  }
  return out;
}

/** 合成之前 */
function forCompose(project, shots) {
  const out = [];
  const noVideo = shots.filter((s) => !s.videoPath);
  if (noVideo.length) {
    out.push({
      id: 'no-video',
      level: 'blocker',
      what: `${noVideo.length} 镜还没有视频`,
      why: '这几镜在成片里会直接缺一块。',
      fix: '先把这几镜的视频出了。',
      shots: idx(noVideo)
    });
  }
  return out;
}

const BY_STAGE = { assets: forAssets, video: forVideo, voice: forVoice, compose: forCompose };

/**
 * 这一步开跑之前该知道什么。
 *
 * @returns {{ stage, targets, items, blockers, warns, tips }}
 *          items 已经按严重程度排好；调用方直接顺着显示就行
 */
export function check(project, stage, { regenerate = false, only = null } = {}) {
  const all = project?.shots || [];
  const scoped = only ? all.filter((s) => only.includes(s.id)) : all;
  const shots = targetsOf(scoped, stage, regenerate);
  const fn = BY_STAGE[stage];
  if (!fn || !shots.length) {
    return { stage, targets: shots.length, items: [], blockers: 0, warns: 0, tips: 0 };
  }
  const rank = { blocker: 0, warn: 1, tip: 2 };
  const items = fn(project, shots).sort((a, b) => rank[a.level] - rank[b.level]);
  return {
    stage,
    targets: shots.length,
    items,
    blockers: items.filter((i) => i.level === 'blocker').length,
    warns: items.filter((i) => i.level === 'warn').length,
    tips: items.filter((i) => i.level === 'tip').length
  };
}

/**
 * 一句话总结。
 *
 * ⚠ 没问题时要**明说"没发现问题"**，不能返回空串。
 *
 * 空串会让界面上那一块整个消失，而"这里什么都没有"和"检查过了、干净的"
 * 是两种意思。前者让人以为功能没跑，于是他会自己再检查一遍 ——
 * 那正是这个功能要消灭的那趟往返。
 */
export function summary(result, { money = '' } = {}) {
  const head = `这一步 ${result.targets} 镜${money ? ` · 约 ${money}` : ''}`;
  if (!result.items.length) return `${head} · 检查过了，没发现问题`;
  const bits = [];
  if (result.blockers) bits.push(`${result.blockers} 处要先处理`);
  if (result.warns) bits.push(`${result.warns} 处建议先改`);
  if (result.tips) bits.push(`${result.tips} 处可选`);
  return `${head} · ${bits.join('、')}`;
}

/**
 * 「现在改是免费的」那句话。
 *
 * 这是整个功能的**支点**：清单本身只是信息，而这句话把它变成一个决定。
 * 没有它的话，用户看到一堆黄字，最省事的做法永远是直接按「开始」。
 */
export function costOfSkipping(result, money) {
  if (!result.items.length || !money) return '';
  return `现在改是免费的；这一步跑完再改，这 ${result.targets} 镜要重花一次 ${money}。`;
}
