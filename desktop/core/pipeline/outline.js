/**
 * 大纲 —— 剧本和分镜之间那一层，**可以商量的那一层**。
 *
 * ════════ 为什么必须有它 ════════
 *
 * 原来是「剧本 →（一次性）分镜表 → 出图」，中间没有任何可以商量的中间物。
 * 而分镜表是个**很坏的对话对象**：
 *
 *   · 二十镜、每镜六七个字段。你想说"第三场太拖了，砍一半"，
 *     得手工去改十几行
 *   · 让模型重跑一次，它会把你**已经审过的镜全换掉** ——
 *     出过图的那几镜跟着作废，钱白花
 *
 * 大纲不一样：十来行，一行一场戏。在这个粒度上说
 * "第 2 场加一段回忆"、"第 3 场挪到第 1 场前面"是一句话的事，
 * 而且改完你还看得懂全貌。改完再拆分镜，拆出来的东西你已经同意过了。
 *
 * ════════ 增量，不是推倒重来 ════════
 *
 * 模型**不回新的完整大纲**，回的是一串改动指令（ops）。理由是：
 * 回完整大纲的话，没法知道它到底改了哪儿 —— 只能整份换掉，
 * 而整份换掉就是"全部推倒重来"，正是这一层要消灭的东西。
 *
 * 回 ops 之后，界面能把每一条摊开给人逐条勾：
 *
 *   ＋ 在第 2 场后面插一场「石阶遇袭」
 *   ✎ 第 3 场的时长 3 分钟 → 2 分钟
 *   － 删掉第 5 场
 *
 * 没勾的一条都不动。"模型建议"和"实际改动"是两件事。
 *
 * ⚠ 已经拆过分镜的场次**锁住**：模型只能建议，不能覆盖。
 * 不锁的话，改一句话就可能把出过图的那几场换掉 —— 而那正是
 * 用户说"不要全部推到重来"时怕的那件事。
 *
 * ⚠ 这个文件要**原样发给浏览器**（/outline.js），所以只能 import duration
 * （它在浏览器里是 /duration.js，那条路由是有的）。
 */

import * as duration from '../duration.js';

/** 一场戏的动作部分大约几秒。只是个量级，不追求准 */
const ACTION_SECONDS = 3.5;

/** 一场戏最短多少秒。再短就不成其为一场戏了 */
export const MIN_BEAT_SECONDS = 4;

export const OP_KINDS = ['insert', 'edit', 'delete', 'move'];

/** 允许模型改的字段。白名单之外的一律丢掉 —— 免得它顺手改了 id 或 locked */
export const BEAT_EDITABLE = ['scene', 'time', 'characters', 'summary', 'dialogue', 'seconds'];

function str(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

function nameList(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,，、]/);
  return list.map((x) => str(x, 24)).filter(Boolean).slice(0, 8);
}

export function normalizeBeat(beat, i = 0) {
  if (!beat || typeof beat !== 'object') return null;
  const summary = str(beat.summary, 300);
  const scene = str(beat.scene, 40);
  if (!summary && !scene) return null;
  const secs = Number(beat.seconds);
  return {
    id: str(beat.id, 24) || `b-${String(i + 1).padStart(2, '0')}`,
    scene,
    time: str(beat.time, 20),
    characters: nameList(beat.characters),
    summary,
    dialogue: str(beat.dialogue, 1000),
    seconds: Number.isFinite(secs) && secs > 0 ? Math.round(secs) : 0,
    chapterId: str(beat.chapterId, 24),
    // 锁住的场次只能被建议，不能被覆盖 —— 见文件头
    locked: beat.locked === true
  };
}

export function normalizeOutline(outline) {
  const beats = (Array.isArray(outline?.beats) ? outline.beats : [])
    .map((b, i) => normalizeBeat(b, i))
    .filter(Boolean);
  return { beats, updatedAt: str(outline?.updatedAt, 40) || null };
}

/**
 * 这一场至少要多少秒 —— **台词念完是硬下限**。
 *
 * ── 为什么这件事该在大纲这一层算 ──
 *
 * 现在的做法是"你先定片长，模型按这个预算拆"，而预算按**字数比例**
 * 分摊到每一章。同样两千字，全是对话的一章念完要 90 秒，全是写景的
 * 一章 40 秒就够 —— 字数一样，分到的秒数就一样。于是对话密集的那章
 * 被压得念不完（要么台词被截断，要么每镜超时），写景那章又被拉得空洞。
 *
 * 而"念不念得完"引擎其实早就算得出来（duration.speechSeconds），
 * 只是那个信息用在**每一镜**上（拆完之后校对）—— 那时候分镜已经拆完了，
 * 改时长等于重拆。
 *
 * 放在大纲这一层，它变成**拆之前**就能说的一句话。
 */
export function estimateSeconds(beat) {
  const floor = duration.speechSeconds(beat?.dialogue);
  // 台词还要留一点余量：话音刚落就切走，观众会觉得被打断
  const spoken = floor ? Number((floor + duration.SPEECH_HEADROOM).toFixed(1)) : 0;
  // 动作按句数估。数不准，但这里要的是量级
  const sentences = String(beat?.summary || '')
    .split(/[。；;！!？?\n]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2).length;
  const action = Math.max(MIN_BEAT_SECONDS, sentences * ACTION_SECONDS);
  const planned = Number(beat?.seconds) || 0;
  return {
    // 硬下限：低于它台词就念不完
    floor: Math.round(spoken),
    // 建议值：人/模型定过就用那个，但不能低于硬下限
    suggested: Math.round(Math.max(planned || action, spoken))
  };
}

export function totalSeconds(outline) {
  return normalizeOutline(outline).beats
    .reduce((sum, b) => sum + estimateSeconds(b).suggested, 0);
}

/**
 * 这份大纲和你定的片长对得上吗。
 *
 * ⚠ 分**两种**说法，因为它们的性质完全不同：
 *
 *   台词超了   **改不动**。除非删台词，否则这个长度是物理下限
 *   总长超了   可以调 —— 砍一场、压几场，都是编辑上的选择
 *
 * 混成一句"超了 30 秒"是没用的：前者要你改剧本，后者要你改节奏。
 */
export function budgetCheck(outline, targetSeconds) {
  const beats = normalizeOutline(outline).beats;
  const target = Number(targetSeconds) || 0;
  if (!beats.length || !target) return null;

  const floor = beats.reduce((s, b) => s + estimateSeconds(b).floor, 0);
  const total = beats.reduce((s, b) => s + estimateSeconds(b).suggested, 0);
  const out = { target, floor, total, beats: beats.length, issues: [] };

  if (floor > target) {
    out.issues.push({
      kind: 'floor-over',
      what: `光台词念完就要 ${duration.fmtSeconds(floor)}，而你定的是 ${duration.fmtSeconds(target)}`,
      why: '这是硬下限，不是节奏问题 —— 除非删台词，否则压不到这个长度。'
        + '硬压的结果是台词被切掉，那是最刺耳的一种错。',
      fix: `把目标时长调到 ${duration.fmtSeconds(Math.ceil(floor / 15) * 15)} 以上，或者删掉一些台词。`
    });
  } else if (total > target * 1.25) {
    out.issues.push({
      kind: 'total-over',
      what: `这份大纲大约 ${duration.fmtSeconds(total)}，比目标 ${duration.fmtSeconds(target)} 长不少`,
      why: '不是硬伤 —— 台词装得下，只是场次安排得比预算长。',
      fix: '砍掉一两场，或者把几场压短。也可以直接把目标时长调上去。'
    });
  } else if (total < target * 0.6) {
    out.issues.push({
      kind: 'total-short',
      what: `这份大纲大约 ${duration.fmtSeconds(total)}，比目标 ${duration.fmtSeconds(target)} 短不少`,
      why: '照这份大纲拆出来的片子会明显短于你要的长度。',
      fix: '加几场，或者把目标时长调下来 —— 硬拉长会让每一镜都拖。'
    });
  }
  return out;
}

/** 生成一个不和现有 id 撞的新 id */
function freshId(beats) {
  let n = beats.length + 1;
  const used = new Set(beats.map((b) => b.id));
  let id = `b-${String(n).padStart(2, '0')}`;
  while (used.has(id)) {
    n += 1;
    id = `b-${String(n).padStart(2, '0')}`;
  }
  return id;
}

/**
 * 把一条改动指令说成人话 —— 界面上那一排勾选项就是它。
 *
 * ⚠ 一定要说**改之前是什么**。只说"第 3 场改成 2 分钟"，人没法判断
 * 该不该勾；说"3 分钟 → 2 分钟"才行。
 */
export function describeOp(op, outline) {
  const beats = normalizeOutline(outline).beats;
  const at = (id) => beats.findIndex((b) => b.id === id);
  const nameOf = (b) => `第 ${at(b.id) + 1} 场${b.scene ? `「${b.scene}」` : ''}`;
  const find = (id) => beats.find((b) => b.id === id);

  if (op?.op === 'insert') {
    const after = op.after ? find(op.after) : null;
    const where = op.after ? `在${after ? nameOf(after) : `「${op.after}」`}后面` : '在最前面';
    const b = normalizeBeat(op.beat, beats.length);
    return `＋ ${where}插一场${b?.scene ? `「${b.scene}」` : ''}：${b?.summary || '（空）'}`;
  }
  if (op?.op === 'delete') {
    const b = find(op.id);
    return `－ 删掉${b ? nameOf(b) : `「${op.id}」`}${b?.summary ? `：${b.summary.slice(0, 30)}` : ''}`;
  }
  if (op?.op === 'move') {
    const b = find(op.id);
    const after = op.after ? find(op.after) : null;
    return `↕ 把${b ? nameOf(b) : `「${op.id}」`}挪到${op.after ? `${after ? nameOf(after) : op.after}后面` : '最前面'}`;
  }
  if (op?.op === 'edit') {
    const b = find(op.id);
    if (!b) return `✎ 改「${op.id}」（找不到这一场）`;
    const bits = [];
    for (const k of BEAT_EDITABLE) {
      if (!(k in (op.fields || {}))) continue;
      const before = Array.isArray(b[k]) ? b[k].join('、') : String(b[k] ?? '');
      const after = Array.isArray(op.fields[k]) ? op.fields[k].join('、') : String(op.fields[k] ?? '');
      if (before === after) continue;
      const label = { scene: '场景', time: '时间', characters: '人物', summary: '内容', dialogue: '台词', seconds: '时长' }[k];
      bits.push(`${label} ${before || '（空）'} → ${after || '（空）'}`);
    }
    return `✎ ${nameOf(b)}：${bits.join('；') || '没有实际改动'}`;
  }
  return `? 看不懂的改动：${JSON.stringify(op).slice(0, 60)}`;
}

/**
 * 应用一串改动指令。**纯函数** —— 不改传进来的那份。
 *
 * ⚠ 纯函数这一点是必须的，不是洁癖：界面要用同一段代码**先预览再应用**。
 * 预览走一套、应用走另一套的话，你勾的和实际发生的迟早对不上，
 * 而那种错只有在数据已经被改坏之后才看得出来。
 *
 * 回 { outline, applied, refused }。refused 里每条都带原因 ——
 * 悄悄跳过一条改动，比拒绝它更糟：人以为改了。
 */
export function applyOps(outline, ops = [], { allowLocked = false } = {}) {
  let beats = normalizeOutline(outline).beats.map((b) => ({ ...b }));
  const applied = [];
  const refused = [];
  const idx = (id) => beats.findIndex((b) => b.id === id);

  const refuse = (op, why) => refused.push({ op, why });

  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || !OP_KINDS.includes(op.op)) {
      refuse(op, '看不懂这条改动');
      continue;
    }

    if (op.op === 'insert') {
      const beat = normalizeBeat({ ...op.beat, id: '', locked: false }, beats.length);
      if (!beat) { refuse(op, '这一场是空的'); continue; }
      beat.id = freshId(beats);
      let pos = beats.length;
      if (op.after) {
        const i = idx(op.after);
        if (i < 0) { refuse(op, `插在哪一场后面说不清：找不到「${op.after}」`); continue; }
        pos = i + 1;
      } else if (op.after === null) {
        pos = 0;
      }
      beats.splice(pos, 0, beat);
      applied.push(op);
      continue;
    }

    const i = idx(op.id);
    if (i < 0) { refuse(op, `找不到这一场：「${op.id}」`); continue; }
    /**
     * 锁住的场次：拆过分镜、可能已经出过图。
     * 覆盖它等于把已经花过钱的东西作废，而且不可撤销。
     */
    if (beats[i].locked && !allowLocked) {
      refuse(op, `第 ${i + 1} 场已经拆过分镜了，锁着 —— 要改先把那一章的分镜清掉`);
      continue;
    }

    if (op.op === 'delete') {
      beats.splice(i, 1);
      applied.push(op);
      continue;
    }
    if (op.op === 'move') {
      const [one] = beats.splice(i, 1);
      let pos = beats.length;
      if (op.after) {
        const j = idx(op.after);
        if (j < 0) {
          // 挪不过去就放回原位，别把它丢在末尾
          beats.splice(i, 0, one);
          refuse(op, `挪到哪一场后面说不清：找不到「${op.after}」`);
          continue;
        }
        pos = j + 1;
      } else if (op.after === null) {
        pos = 0;
      }
      beats.splice(pos, 0, one);
      applied.push(op);
      continue;
    }
    // edit
    const fields = op.fields && typeof op.fields === 'object' ? op.fields : {};
    const patch = {};
    for (const k of BEAT_EDITABLE) {
      if (k in fields) patch[k] = fields[k];
    }
    if (!Object.keys(patch).length) { refuse(op, '这条改动没说要改什么'); continue; }
    beats[i] = normalizeBeat({ ...beats[i], ...patch }, i);
    // ⚠ normalizeBeat 会按位置补 id，而这一场本来就有 id —— 补回去
    beats[i].id = op.id;
    beats[i].locked = false;
    applied.push(op);
  }

  return {
    outline: { beats, updatedAt: new Date().toISOString() },
    applied,
    refused
  };
}

/**
 * 把某一章的场次**锁住** —— 拆过分镜就锁。
 *
 * 抽成独立函数是为了测得动：它埋在 analyzeScript 里几百行的中间时，
 * 想验它只能把整条流水线跑一遍（要模型、要出图）。而这一条守的是
 * 用户那句"不要全部推到重来"——它必须有断言，不能靠"应该没问题"。
 *
 * chapterId 传 null = 整份都锁（没分章的项目，拆一次就是全片拆完）。
 */
export function lockBeats(outline, chapterId = null) {
  const o = normalizeOutline(outline);
  return {
    ...o,
    beats: o.beats.map((b) => (
      chapterId === null || b.chapterId === chapterId ? { ...b, locked: true } : b
    ))
  };
}

/**
 * 解锁某几场 —— 准备重拆它们。
 *
 * ⚠ 这个动作**必须是人点的**，不能自动发生。
 *
 * 解锁之后重拆，那几场已经出好的图和视频会作废。作废是对的（内容都变了，
 * 旧图对不上新分镜），但它花过钱，所以要人自己确认一次。
 *
 * ids 传空 = 全解锁。
 */
export function unlockBeats(outline, ids = []) {
  const want = new Set((ids || []).map((x) => String(x)));
  const o = normalizeOutline(outline);
  return {
    ...o,
    beats: o.beats.map((b) => (
      !want.size || want.has(b.id) ? { ...b, locked: false } : b
    ))
  };
}

/** 一场戏一行，给提示词和摘要用 */
export function toLines(outline) {
  return normalizeOutline(outline).beats.map((b, i) => {
    const est = estimateSeconds(b);
    const who = b.characters.length ? ` · ${b.characters.join('、')}` : '';
    const when = b.time ? ` · ${b.time}` : '';
    return `${i + 1}. ${b.scene || '（未定场景）'}${when}${who}　${duration.fmtSeconds(est.suggested)}　${b.summary}`;
  });
}

/**
 * 这份大纲的一句话摘要。
 *
 * 空的时候也要有话说 —— 一块空白让人以为功能坏了，
 * 一句话让人知道下一步该干什么。
 */
export function summarize(outline, targetSeconds) {
  const o = normalizeOutline(outline);
  if (!o.beats.length) return '还没有大纲 —— 先从剧本生成一份，改顺了再拆分镜';
  const total = totalSeconds(o);
  const locked = o.beats.filter((b) => b.locked).length;
  const bits = [`${o.beats.length} 场，约 ${duration.fmtSeconds(total)}`];
  if (targetSeconds) bits.push(`目标 ${duration.fmtSeconds(Number(targetSeconds))}`);
  if (locked) bits.push(`${locked} 场已拆过分镜（锁着）`);
  return bits.join(' · ');
}
