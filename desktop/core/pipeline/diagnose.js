/**
 * ══════════ 这一镜不满意，下一步该干什么 ══════════
 *
 * ── 和 shotIssues 的分工 ──
 *
 * 手机上那个 shotIssues 答的是**流水线状态**：还没出图、有图没视频、
 * 有台词没配音。那些是"缺东西"，一看就知道。
 *
 * 这里答的是另一个问题，而且是更难的那个：**东西都出来了，但不对**。
 * 脸不像、构图不是想要的、和别的镜头接不上 —— 这时候人手里只有一张
 * 不满意的图，和一个"再来一次"按钮。而再来一次多半还是那样，
 * 因为他不知道该改什么。
 *
 * ── 一条铁律：只说**数据里有证据**的原因 ──
 *
 * "可能是提示词不够具体"这种话不能说。它永远成立、永远没用，
 * 而且会把真正的原因（这一镜一张参考图都没发）淹掉。
 *
 * 所以每一条都必须挂在一个具体字段上：refsSent 是 0、
 * editedAt 比 imageAt 新、modelUsed 和现在路由的不是同一个。
 * 没有证据就不说 —— 宁可只给两条真的，也不给五条凑数的。
 *
 * ── 排序按"改了最可能有用" ──
 *
 * 不是按严重程度。人只会试最上面那一两条，所以第一条必须是
 * **动手成本最低、见效概率最高**的那个。
 */

import * as shotlint from './shotlint.js';
import * as previz from './previz.js';
import * as consistency from './consistency.js';

/** 一条诊断：为什么、怎么办、这一下要不要花钱 */
const say = (id, what, why, how, { costs = false, weight = 50 } = {}) =>
  ({ id, what, why, how, costs, weight });

/**
 * @param shot     这一镜
 * @param ctx      { bible, routing, prevShot }
 */
export function diagnose(shot, { bible = null, routing = null, prevShot = null } = {}) {
  if (!shot?.imagePath) return [];
  const out = [];

  /**
   * ══════════ 第一梯队：一张参考图都没发 ══════════
   *
   * 这是"脸不像"最常见、也最容易被忽略的原因 —— 因为它不报任何错。
   * 图出来了、好看、就是不是那个人。而排查时人几乎不会想到
   * "是不是根本没带参考图"，他会去改描述、换模型、加提示词。
   */
  const sent = Number(shot.refsSent ?? (shot.bibleRefs || []).length);
  const avail = Number(shot.refsAvailable ?? 0);
  if (avail > 0 && sent === 0) {
    out.push(say(
      'no-refs',
      '这一镜一张参考图都没发出去',
      shot.refBlockedHint
        ? `原因：${shot.refBlockedHint}`
        : `设定集里有 ${avail} 张可以带，但这一次一张都没带 —— `
          + '也就是说这一镜的脸完全由文字描述决定，和设定图没关系。',
      '去「设置 → 画面规格 → 出分镜图时带哪些参考图」看一下，然后重出这一镜。',
      { costs: true, weight: 5 }
    ));
  } else if (avail > sent && sent > 0) {
    out.push(say(
      'refs-capped',
      `设定集里有 ${avail} 张可带，这次只发了 ${sent} 张`,
      '超出上限的被挤掉了。挤掉的多半是道具，但如果这一镜有好几个人，'
        + '也可能是某个人的设定图没发出去 —— 那个人就会不像。',
      '「设置 → 画面规格」把上限调大，或者把这一镜的「关键道具」删短一点。',
      { costs: true, weight: 25 }
    ));
  }

  /**
   * ══════════ 分镜里点了名的人，设定集里找不到 ══════════
   *
   * 这一条排在很前面，因为它**看起来完全不像配置问题**。
   *
   * 名字对不上时，那个人的设定图不会发出去，而其它人的照发 ——
   * 于是出来的图里少一个人、或者那个人的脸每一镜都在换。
   * 人看到的是"模型不行""这一镜怎么只有一个人"，
   * 会去改描述、换模型、重出十次，而真正的原因是设定集里叫
   *「我（无灵根书信摊主）」、分镜里写的是「我」。
   *
   * 改名是免费的，而且改一次全片都好了 —— 这是性价比最高的一条。
   */
  const missing = bible ? consistency.unmatchedCast(bible, shot) : [];
  if (missing.length) {
    const have = (bible?.characters || []).map((c) => c.name);
    out.push(say(
      'cast-unmatched',
      `分镜里的「${missing.join('」「')}」在设定集里找不到对应的角色`,
      `所以${missing.length > 1 ? '这几个人' : '这个人'}的设定图一张都没发出去 —— `
        + '他的长相完全由文字描述决定，每一镜都会换一张脸，而且不报任何错。'
        + (have.length ? `设定集里现有的是：${have.join('、')}。` : ''),
      '把两边的名字改成一致：要么改设定集里那个角色的名字，'
        + '要么改这一镜的「出场角色」。改完重出这一镜。',
      { costs: false, weight: 3 }
    ));
  }

  /**
   * ══════════ 图是照旧描述出的 ══════════
   *
   * 改完描述没重出图，然后觉得"改了没用"—— 而事实是那张图根本没重画过。
   */
  const edited = Date.parse(shot.editedAt || 0) || 0;
  const imaged = Date.parse(shot.imageAt || 0) || 0;
  if (edited && imaged && edited > imaged) {
    out.push(say(
      'stale-image',
      '这张图是**改描述之前**出的',
      '你后来改过这一镜的文字，但图没跟着重出 —— 所以你看到的还是照旧描述画的那张。',
      '重出这张图。',
      { costs: true, weight: 1 }
    ));
  }

  /**
   * ══════════ 中途换过模型 ══════════
   *
   * 风格漂移最常见的原因，而且它不报任何错：只是第 6 镜起画风变了，
   * 人会以为是提示词的问题。
   */
  const now = routing?.image ? `${routing.image.provider} / ${routing.image.model}` : '';
  if (now && shot.modelUsed && shot.modelUsed !== now) {
    out.push(say(
      'model-changed',
      `这张图是 ${shot.modelUsed} 出的，而现在路由到的是 ${now}`,
      '换过模型是风格漂移最常见的原因，而它不报任何错 —— 表现就是'
        + '"某几镜画风和别的不一样"，你会以为是提示词的问题。',
      '要么把出图模型换回去、要么把这一镜（和风格不一致的其它几镜）用现在这个重出一遍。',
      { costs: true, weight: 20 }
    ));
  }

  /**
   * ══════════ 复核给的具体偏差 ══════════
   *
   * ⚠ 只在**分数是对这张图打的**时候说。改过文字之后那个分数就不作数了，
   * 拿它当依据会把人引向一个已经不存在的问题。
   */
  const c = shot.consistency;
  if (c && !c.stale && c.score != null && c.pass === false) {
    out.push(say(
      'verify-failed',
      `一致性复核只有 ${c.score} 分`,
      (c.issues || []).length
        ? `复核说：${(c.issues || []).slice(0, 3).join('；')}`
        : '复核认为这一镜里的人和设定图对不上，但没说具体哪儿。',
      '重出一次（会换一颗种子）。连着两三次都不过的话，多半是设定图本身'
        + '和这一镜的描述有冲突 —— 去设定集看看那段外貌描述。',
      { costs: true, weight: 30 }
    ));
  }

  /**
   * ══════════ 技法卡和排位在打架 ══════════
   *
   * 两句话会一起进同一条提示词而且挨着，模型只能挑一句听 ——
   * 挑哪句你控制不了，而且什么错都不报。
   */
  for (const conflict of previz.conflictingSkills(shot) || []) {
    out.push(say(
      `conflict-${conflict.id}`,
      '技法卡和预演台的排位说的不是一回事',
      `技法卡说的和排位算出来的「${conflict.said}」冲突。两句话会一起发给模型、`
        + '而且挨在一起，模型只能挑一句听 —— 表现就是"排了位好像没生效"。',
      '要么去掉那张技法卡，要么把排位改成和它一致。',
      { costs: false, weight: 10 }
    ));
  }

  /**
   * ══════════ 描述本身有毛病 ══════════
   *
   * 只取高危那几条（声音写进画面、一镜塞了好几件事）—— 它们直接决定
   * 这张图画不画得对，而且改起来不花钱。
   */
  for (const it of shotlint.lintShot(shot) || []) {
    if (it.severity !== 'high') continue;
    out.push(say(`lint-${it.kind}`, it.what, it.why, it.fix, { costs: false, weight: 12 }));
  }

  /**
   * ══════════ 什么都没查出来 ══════════
   *
   * ⚠ 这一条**必须有**，而且不能假装找到了原因。
   *
   * 一个"没查出问题"的空列表，和"这个功能没跑"长得一模一样 ——
   * 人会以为是我们没检查。说清楚"查过了、数据上看不出毛病"，
   * 再给一个真的能往前走的动作，比编一条像模像样的猜测有用得多。
   */
  if (!out.length) {
    out.push(say(
      'nothing-found',
      '数据上看不出毛病',
      '参考图发了、图是按现在这版描述出的、模型没换过、复核也过了 —— '
        + '也就是说这是"模型这一次就画成了这样"，不是哪儿配错了。',
      '重出一次换颗种子，多半就不一样了。连试两三次都不满意的话，'
        + '改描述比重试有用：把你不满意的那一点直接写进画面描述。',
      { costs: true, weight: 99 }
    ));
  }

  return out.sort((a, b) => a.weight - b.weight);
}

/**
 * 全片里哪几镜"该重出"。
 *
 * ⚠ 判据是**有可以动手的具体原因**，不是"分数低"。
 *
 * 按分数选的话，会把一堆"数据上看不出毛病、只是模型这次画成这样"的镜头
 * 一起选上 —— 重出它们纯粹是碰运气，而每一次都真花钱。
 * 只选那些有明确原因的：图是旧描述出的、参考图没发、模型换过。
 */
export function needsRedo(shots = [], ctx = {}) {
  const out = [];
  for (const s of shots) {
    const found = diagnose(s, ctx).filter((d) => d.id !== 'nothing-found');
    if (found.length) out.push({ id: s.id, index: s.index, why: found[0].what, count: found.length });
  }
  return out;
}
