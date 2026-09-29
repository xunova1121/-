/**
 * 场次 —— **先决定在哪儿断，再决定拆成几镜**。
 *
 * ════════ 为什么要倒过来 ════════
 *
 * 原来的顺序是反的：模型先把剧本拆成一串镜头，转场是拆完之后
 * 每一镜自己填的一个字段。那等于让"这里要不要断"变成一个**事后贴的标签**。
 *
 * 而真实的剪辑逻辑是倒着来的：**该在哪儿断，决定了该拆成几镜**。
 * 一个转场点意味着时间跳了或者地点换了 —— 跨过那个点的两镜，
 * 根本就不该按"一个连续动作"去拆，也不可能做动作接切。
 *
 * 顺序反了会实实在在出错：模型可以给两镜标上「连续动作」，
 * 而它们之间明明隔了二十年。那对分镜会去锁末帧、会走链式参考，
 * 出来的东西说不上哪里怪，但就是怪 —— 而且没有任何一处会报错。
 *
 * ════════ 一个场次是什么 ════════
 *
 * 同一个时间、同一个地点里连续发生的一段戏。
 * 边界 = **时间跳了** 或者 **地点换了**（两者有一个就算）。
 *
 * 注意它比"场景"更细：同一间办公室、二十年后，是**两个场次**、
 * 但很可能挂着同一个场景名。这正是光靠 scene 名比对不够的原因。
 *
 * ════════ 边界上强制哪些事 ════════
 *
 *   跨边界   一定是 new-scene，不许 continuous ——
 *            锁末帧是"这一帧的下一瞬间"，跨了二十年没有这回事
 *   边界上   才允许黑场 / 叠化。这是转场唯一该出现的位置
 *   边界内   一律硬切。满屏叠化是最典型的业余标志
 *
 * 提示词里也写了这些规矩，但**提示词不是保证** —— 模型不是每次都听。
 * 所以这里在解析模型输出时**强制归一**，而不是相信它。
 *
 * ⚠ 只归一模型的输出，**不动用户手改的**。人明确选了「这两镜叠化」，
 * 那是他的决定；界面上自己变回去比不做还糟。手改违规的那些由分镜体检去提醒。
 */
import * as transitions from '../transitions.js';

/** 转场只允许出现在场次边界上。边界内一律硬切 */
export const ENTER_KINDS = transitions.KINDS;

/**
 * 模型给的场次表，洗成能用的样子。
 *
 * 模型没给（老模型、输出跑偏）时回空数组，让调用方退回按场景名推断 ——
 * 少一个字段不该让整步失败，那是"新功能把老路弄坏了"的经典长相。
 */
export function normalizeSegments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((seg, i) => ({
      index: Number(seg?.index) || i + 1,
      where: String(seg?.where || '').trim(),
      when: String(seg?.when || '').trim(),
      summary: String(seg?.summary || '').trim(),
      // 第一段没有"进入方式"可言 —— 它前面什么都没有
      enter: i === 0 ? 'cut' : ENTER_KINDS.includes(seg?.enter) ? seg.enter : 'cut',
      seconds: Number(seg?.seconds) > 0 ? Number(seg.seconds) : null
    }))
    .map((seg, i) => ({ ...seg, index: i + 1 }));
}

/**
 * 每一镜属于哪个场次。
 *
 * 模型标了就用它的（夹到合法范围内），没标就按场景名变化推断 ——
 * 推断出来的比没有强，而且它退化后的行为正好等于改这一版之前的行为。
 */
export function assignSegments(shots = [], segments = []) {
  const count = segments.length;
  let derived = 1;
  let prevScene = null;

  return shots.map((s, i) => {
    let seg;
    if (count && Number.isFinite(Number(s?.segment))) {
      seg = Math.min(count, Math.max(1, Math.round(Number(s.segment))));
    } else {
      // 场景名一变就算新场次。抓不到"同地点不同时间"那种，但不会抓错
      const scene = String(s?.scene || '').trim();
      if (i > 0 && scene && prevScene && scene !== prevScene) derived += 1;
      prevScene = scene || prevScene;
      seg = derived;
    }
    return { ...s, segment: seg };
  });
}

/** 这一镜是不是某个场次的头一镜（整片第一镜也算） */
export function startsSegment(shot, prev) {
  if (!prev) return true;
  // 跨章一定是新场次 —— 跨章的"上一镜"不是同一段戏
  if ((prev.chapterId || null) !== (shot?.chapterId || null)) return true;
  return Number(prev.segment || 1) !== Number(shot?.segment || 1);
}

/**
 * 把场次的规矩**落到**每一镜上。
 *
 * 这一步是这个模块存在的理由：提示词只是请求，这里才是保证。
 *
 * 返回顺便带上改了哪些 —— 改了什么必须能说出来。
 * 悄悄改用户看得见的字段，是这类"归一化"最容易犯的错。
 */
export function enforce(shots = [], segments = []) {
  const changes = [];
  const out = shots.map((shot, i) => {
    const prev = i ? shots[i - 1] : null;
    const head = startsSegment(shot, prev);
    const next = { ...shot };

    if (i === 0) {
      /**
       * 整片第一镜没有"转场"可言 —— 它前面什么都没有。
       * 合成那一层也是这么处理的（transitions[0] 恒为 cut），
       * 这里跟着来，免得界面上显示一个**永远不会生效**的叠化。
       */
      if (next.transition && next.transition !== 'cut') {
        changes.push({ index: next.index, what: 'transition', from: next.transition, to: 'cut', why: '第一镜前面没有画面，转不了场' });
      }
      next.transition = 'cut';
      next.link = 'new-scene';
      return next;
    }

    if (head) {
      const want = segments[Number(next.segment || 1) - 1]?.enter || next.transition || 'cut';
      const kind = ENTER_KINDS.includes(want) ? want : 'cut';
      if (next.transition !== kind) {
        changes.push({ index: next.index, what: 'transition', from: next.transition || 'cut', to: kind, why: '这一镜是新场次的开头，按场次的进入方式来' });
      }
      next.transition = kind;
      /**
       * 跨场次不许「连续动作」。
       *
       * 这是整条规矩里唯一会造成**真实损失**的一条：continuous 会把
       * 上一镜的末帧锁成这一镜的首帧。跨了时间地点还这么锁，
       * 等于强行让二十年后那一镜长得跟二十年前一样 —— 而且不报错。
       */
      if (next.link === 'continuous' || next.link === 'cut') {
        changes.push({ index: next.index, what: 'link', from: next.link, to: 'new-scene', why: '跨场次不可能是连续动作，也不是同场换机位' });
      }
      next.link = 'new-scene';
      return next;
    }

    // 场次内部：一律硬切。中间来一下叠化是最典型的业余做法
    if (next.transition && next.transition !== 'cut') {
      changes.push({ index: next.index, what: 'transition', from: next.transition, to: 'cut', why: '场次内部一律硬切，转场只出现在场次之间' });
    }
    next.transition = 'cut';
    // link 交给上层按老规矩推断，这里不碰 —— 场次内部本来就该由它自己决定
    return next;
  });

  return { shots: out, changes };
}

/**
 * 这份分镜表被叠化吃掉多少秒。
 *
 * 时长预算必须减掉它，否则成片会比计划短 —— 而且是**悄悄**短：
 * 没有一处会报错，你只会觉得"怎么比说好的少了两秒"。
 */
export function overlapCost(shots = []) {
  return shots.reduce((sum, s, i) => (i === 0 ? 0 : sum + transitions.overlapOf(s)), 0);
}

/** 一句话摘要，给事件流用 */
export function summarize(segments = [], shots = []) {
  if (!segments.length) return null;
  const counts = segments.map((_, i) => shots.filter((s) => Number(s.segment) === i + 1).length);
  const parts = segments.slice(0, 6).map((seg, i) => {
    const enter = i === 0 ? '' : `${transitions.LABELS[seg.enter]?.replace(/（.*/, '') || seg.enter}·`;
    return `${enter}${seg.where || seg.summary || `第${seg.index}场`}${seg.when ? `（${seg.when}）` : ''} ${counts[i]} 镜`;
  });
  return `${segments.length} 个场次：${parts.join(' ｜ ')}${segments.length > 6 ? ' …' : ''}`;
}
