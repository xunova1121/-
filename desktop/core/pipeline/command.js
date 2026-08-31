/**
 * ══════════ 指令框：把人话翻成"要做什么" ══════════
 *
 * ── 为什么不是"智能体自动拆解任务" ──
 *
 * 那个形态听起来更聪明，但对这个应用是**减分**的，三条理由：
 *
 *   ① 拆解本来就是固定的。短片就是 设定集→分镜→出图→视频→配音→合成，
 *      顺序永远一样，runAll 早就在做了。让模型每次重新决定一遍，
 *      是把一个确定的东西换成一个不确定的东西。
 *
 *   ② 每一步都在花真钱。「停下来」「预检清单」「花费估算」不是装饰，
 *      是用户被烧过之后加的。一个能自主决定"那我先把 51 镜出图跑了"
 *      的东西，等于把那几道闸门拆掉。
 *
 *   ③ 排查会瞎掉。这个项目里挖出来的 bug 几乎全是**静默失败**——
 *      参考图发重了、角色名对不上、同一份逻辑抄了两份。
 *      每一个都是因为状态结构化、可检查才找得到的。
 *      中间加一层"智能体决定做什么"，就是再加一个出错了看不见的地方。
 *
 * ── 所以这里做的是另一件事 ──
 *
 * **它只会做你已经能做的事**，而且做之前把要做什么摆出来。
 * 每一条指令都落到一个现成的接口上（batchUpdateShots / runAll /
 * diagnoseShot / stepCheck / estimate），没有一条是新造的能力。
 *
 * ── 三条铁律 ──
 *
 *   **一、这个模块不执行任何东西。** parse() 只返回一份计划。
 *   执行是调用方的事，而且中间必须隔着一次人确认。
 *   纯函数还有个好处：测起来没有夹具，输入什么就是什么。
 *
 *   **二、看不懂就说看不懂。** 绝不猜。猜错的代价是拿真钱重跑几十镜，
 *   而"我不确定你是不是要改第 6 到 12 镜"这句话的代价是你再打一遍。
 *   两者差着三个数量级。
 *
 *   **三、花钱的和不花钱的必须分开标。** 改文字是免费的、随便试；
 *   出图出视频是真金白银。计划里 costs 这个字段决定界面要不要
 *   走预检和估算那一套 —— 它一旦标错，那套闸门就形同虚设。
 */

import * as previz from './previz.js';
import * as transitions from '../transitions.js';
import * as skillsLib from '../skills.js';

/** 全角数字 / 各种破折号，先规整掉，不然后面每条正则都要重写一遍 */
function tidy(text) {
  return String(text || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[—–~～至]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 技法名 → id。名字是用户看得见的那个词，所以按名字认 */
function skillIndex() {
  const out = [];
  for (const g of skillsLib.catalogForUI() || []) {
    for (const s of g.skills || []) out.push({ id: s.id, name: s.name, group: g.name });
  }
  // 长的先匹配：「固定镜头」要先于「固定」被认出来
  return out.sort((a, b) => b.name.length - a.name.length);
}

// ──────────────────────────────── 选哪几镜 ────────────────────────────────

const hasImage = (s) => Boolean(s.imagePath);
const hasVideo = (s) => Boolean(s.videoPath);
const hasVoice = (s) => Boolean(s.voicePath);

/**
 * 从一句话里认出"要动哪几镜"。
 *
 * ⚠ 返回 null 表示**没说**，不是"没选中"。两者差别很大：
 * 没说 → 得问一句（"要改哪几镜？"）；
 * 选中零镜 → 可以直接告诉他"符合条件的一镜都没有"。
 * 混成一个的话，用户会对着"改了 0 镜"发愣。
 */
export function selectShots(text, shots = []) {
  const t = tidy(text);
  const all = shots || [];
  const by = (fn, say) => ({ ids: all.filter(fn).map((s) => s.id), say, kind: 'filter' });

  // ── 按编号：第6到12镜 / 6-12 / 第6镜 / 6、8、11镜 ──
  const range = /第?\s*(\d+)\s*-\s*(\d+)\s*镜?/.exec(t);
  if (range) {
    const lo = Math.min(Number(range[1]), Number(range[2]));
    const hi = Math.max(Number(range[1]), Number(range[2]));
    const ids = all.filter((s) => s.index >= lo && s.index <= hi).map((s) => s.id);
    return { ids, say: `第 ${lo}-${hi} 镜`, kind: 'range' };
  }
  const list = /(?:第\s*)?((?:\d+\s*[、,，]\s*)+\d+)\s*镜/.exec(t);
  if (list) {
    const nums = list[1].split(/[、,，]/).map((n) => Number(n.trim())).filter(Boolean);
    const want = new Set(nums);
    const ids = all.filter((s) => want.has(s.index)).map((s) => s.id);
    return { ids, say: `第 ${nums.join('、')} 镜`, kind: 'list' };
  }
  const one = /第\s*(\d+)\s*镜|镜\s*(\d+)\b|\bSH\s*0*(\d+)/i.exec(t);
  if (one) {
    const n = Number(one[1] || one[2] || one[3]);
    const ids = all.filter((s) => s.index === n).map((s) => s.id);
    return { ids, say: `第 ${n} 镜`, kind: 'one', index: n };
  }

  // ── 按场次 ──
  const seg = /第\s*(\d+)\s*场/.exec(t);
  if (seg) {
    const n = Number(seg[1]);
    const ids = all.filter((s) => Number(s.segment) === n).map((s) => s.id);
    return { ids, say: `第 ${n} 场`, kind: 'segment' };
  }

  // ── 按状态。这几个正是筛选条上那几个，口径必须一致 ──
  if (/缺视频|没视频|没有视频/.test(t)) return by((s) => hasImage(s) && !hasVideo(s), '缺视频的');
  if (/缺图|没图|没有图/.test(t)) return by((s) => !hasImage(s), '还没出图的');
  if (/缺配音|没配音|没有配音/.test(t)) return by((s) => Boolean(s.dialogue) && !hasVoice(s), '有台词但还没配音的');

  // ── 按出场角色：「有父亲的镜头」 ──
  const who = /(?:有|带|出现)\s*([^\s的]{1,12})\s*的(?:那些|那几)?镜/.exec(t);
  if (who) {
    const name = who[1];
    const ids = all
      .filter((s) => (s.characters || []).some((c) => String(c).includes(name) || name.includes(String(c))))
      .map((s) => s.id);
    return { ids, say: `有「${name}」出场的镜头`, kind: 'cast' };
  }

  if (/所有|全部|每一镜|全片/.test(t)) return { ids: all.map((s) => s.id), say: '全部镜头', kind: 'all' };

  return null; // 没说
}

// ──────────────────────────────── 要改成什么 ────────────────────────────────

/**
 * 从一句话里认出"改哪个字段、改成什么"。
 *
 * ⚠ 只认**能验证**的那几样：景别、时长、转场、技法、场次。
 *
 * 不做"改描述"这类自由文本 —— 那需要模型重写，而重写的结果没法在
 * 执行前摆给人看（摆出来就等于已经写完了）。那种事留在编辑器里做，
 * 人自己写、自己看。指令框做的是**批量的、结构化的、确定的**那部分。
 */
export function parseEdit(text) {
  const t = tidy(text);

  // ── 景别 ──
  if (/景别|改成|换成/.test(t)) {
    const word = previz.sizeWordIn?.(t) || matchSizeWord(t);
    if (word) return { patch: { camera: word }, say: `的景别改成「${word}」` };
  }

  // ── 时长 ──
  const dur = /(?:时长|长度|时间).{0,4}?(\d+(?:\.\d+)?)\s*秒|(\d+(?:\.\d+)?)\s*秒(?:钟)?(?:$|[^前后])/.exec(t);
  if (dur && /时长|长度|秒/.test(t)) {
    const n = Number(dur[1] || dur[2]);
    if (Number.isFinite(n) && n > 0) return { patch: { duration: n }, say: `的时长改成 ${n} 秒` };
  }

  // ── 转场 ──
  if (/转场|衔接|切换/.test(t)) {
    const hit = (transitions.CATALOG || [])
      .map((x) => ({ ...x, bare: x.label.replace(/（.*?）/g, '') }))
      .sort((a, b) => b.bare.length - a.bare.length)
      .find((x) => t.includes(x.bare));
    if (hit) return { patch: { transition: hit.id }, say: `的转场改成「${hit.bare}」` };
  }

  // ── 技法卡：加上 / 去掉 ──
  const idx = skillIndex();
  const add = [];
  const remove = [];
  for (const s of idx) {
    if (!t.includes(s.name)) continue;
    /**
     * ⚠ 中文两种语序都要认：
     *   「去掉跟拍」  减号词在名字**前面**
     *   「把跟拍去掉」减号词在名字**后面**
     * 只看前面的话，第二种会被当成"加上跟拍"—— 意思正好反了，
     * 而且是静默反：界面显示已加上，用户以为自己说错了话。
     */
    const at = t.indexOf(s.name);
    const near = t.slice(Math.max(0, at - 6), at) + t.slice(at + s.name.length, at + s.name.length + 6);
    if (/去掉|删掉|取消|不要|移除|别用/.test(near)) remove.push(s);
    else if (/加上|加个|添加|用上|改成|换成|设成/.test(t)) add.push(s);
  }
  if (add.length || remove.length) {
    const say = [
      add.length ? `加上「${add.map((s) => s.name).join('、')}」` : '',
      remove.length ? `去掉「${remove.map((s) => s.name).join('、')}」` : ''
    ].filter(Boolean).join('，');
    return { addSkills: add.map((s) => s.id), removeSkills: remove.map((s) => s.id), say };
  }

  return null;
}

/** 景别词。previz 那张表是私有的，这里按同一份档位名认，长的先匹配 */
function matchSizeWord(t) {
  const words = ['大特写', '特写', '近景', '中景', '全景', '远景'];
  return words.find((w) => t.includes(w)) || null;
}

// ──────────────────────────────── 要跑哪一步 ────────────────────────────────

const STAGES = [
  { id: 'bible', label: '设定集', words: ['设定集', '设定图', '人设图'] },
  { id: 'script', label: '分镜', words: ['分镜', '拆分镜', '拆镜头'] },
  { id: 'assets', label: '镜头出图', words: ['出图', '镜头图', '分镜图'] },
  { id: 'video', label: '视频生成', words: ['视频', '出视频', '生成视频'] },
  { id: 'voice', label: '配音', words: ['配音', '语音'] },
  { id: 'compose', label: '合成', words: ['合成', '成片', '出片'] }
];

export function parseRun(text) {
  const t = tidy(text);
  if (!/跑|生成|出|开始|继续/.test(t)) return null;
  const all = /往后全跑|全跑|一路跑|都跑完|跑到底/.test(t);
  const hit = STAGES.find((s) => s.words.some((w) => t.includes(w)));
  if (!hit && !all) return null;
  return { stage: hit?.id || 'assets', label: hit?.label || '镜头出图', andAfter: all };
}

// ──────────────────────────────── 要问什么 ────────────────────────────────

export function parseAsk(text) {
  const t = tidy(text);
  if (/为什么|怎么回事|哪儿不对|哪里不对|咋回事/.test(t)) return { topic: 'diagnose' };
  if (/多少钱|花多少|要花|费用|成本/.test(t)) return { topic: 'estimate' };
  if (/缺(什么|啥)|还差|进度|到哪了|跑到哪/.test(t)) return { topic: 'progress' };
  return null;
}

// ──────────────────────────────── 总入口 ────────────────────────────────

/**
 * 一句人话 → 一份计划。**不执行任何东西。**
 *
 * @returns 认出来了 { ok:true, verb, say, targets, targetSay, costs, action }
 *          没认出来 { ok:false, why, examples }
 */
export function parse(text, project = {}) {
  const t = tidy(text);
  if (!t) return { ok: false, why: '还没说要做什么', examples: examplesFor(project) };

  const shots = project.shots || [];
  const sel = selectShots(t, shots);

  // ── 问一问（不改、不花钱） ──
  const ask = parseAsk(t);
  if (ask) {
    return {
      ok: true,
      verb: 'ask',
      topic: ask.topic,
      targets: sel?.ids || [],
      targetSay: sel?.say || '全片',
      costs: false,
      say: {
        diagnose: `看看${sel?.say || '有问题的镜头'}是怎么回事`,
        estimate: `算一下${sel?.say ? `${sel.say}这几镜` : '这一轮'}要花多少钱`,
        progress: '看看现在跑到哪了、还缺什么'
      }[ask.topic]
    };
  }

  // ── 跑一步（花钱） ──
  const run = parseRun(t);
  if (run) {
    return {
      ok: true,
      verb: 'run',
      stage: run.stage,
      andAfter: run.andAfter,
      targets: sel?.ids || [],
      targetSay: sel?.say || '全片',
      /**
       * ⚠ 这里必须是 true。界面靠它决定要不要走预检和花费估算 ——
       * 标错的话那两道闸门就形同虚设，而这是用户被烧过之后才加上的。
       */
      costs: true,
      say: run.andAfter
        ? `从「${run.label}」开始往后全跑${sel?.ids?.length ? `（只跑${sel.say}）` : ''}`
        : `跑「${run.label}」${sel?.ids?.length ? `，只跑${sel.say}` : ''}`
    };
  }

  // ── 改一批（免费，但要确认） ──
  const edit = parseEdit(t);
  if (edit) {
    if (!sel) {
      return {
        ok: false,
        why: `听懂了要「${edit.say}」，但没说要改哪几镜。`,
        // 这里缺的是"改哪几镜"，所以例子要**带镜头范围**，而且是他真有的那些
        examples: examplesFor(project).filter((x) => /镜/.test(x))
      };
    }
    if (!sel.ids.length) {
      return {
        ok: false,
        why: `「${sel.say}」一镜都没有 —— 没有可改的。`,
        examples: []
      };
    }
    return {
      ok: true,
      verb: 'edit',
      targets: sel.ids,
      targetSay: sel.say,
      patch: edit.patch || {},
      addSkills: edit.addSkills || [],
      removeSkills: edit.removeSkills || [],
      /** 改文字不花钱。但改完那几镜的图就旧了，界面该提示重出 —— 那是另一件事 */
      costs: false,
      /**
       * ⚠ 这句话是**用户确认前唯一会读的东西**，所以它必须读得通。
       * 「的」归各条 edit 自己带（改字段的带、加技法的不带），
       * 模板里再补一个就成了"的的"；镜数只在多于一镜时报，
       * 「第 6 镜（共 1 镜）」是废话。
       */
      say: `把${sel.say}${sel.ids.length > 1 ? `（共 ${sel.ids.length} 镜）` : ''}${edit.say}`
    };
  }

  /**
   * ══════════ 看不懂 ══════════
   *
   * ⚠ 这里**绝不能猜一个最像的去执行**。
   *
   * 猜错的代价是拿真钱重跑几十镜，或者把几十镜的文案改坏；
   * 而"没听懂，你是不是想说……"的代价是你再打一遍。差三个数量级。
   *
   * 但也不能只回一句"看不懂" —— 那等于让人去猜我们支持什么句式。
   * 所以把**认出了哪一半**说出来：认出了镜头没认出动作，就说这个。
   */
  return {
    ok: false,
    why: sel
      ? `认出了「${sel.say}」，但没听懂要对它做什么。`
      : '没听懂这一句。',
    understood: sel ? { targetSay: sel.say, count: sel.ids.length } : null,
    examples: examplesFor(project)
  };
}

/**
 * 界面上列的例子 —— **可点的模板**，点一下就填进输入框。
 *
 * ⚠ 必须按**这个项目**生成，不能写死。
 *
 * 写死的话，"第 6-12 镜改成中景"在一个只有 2 镜的项目里选不到任何东西，
 * 用户第一次点例子就撞一堵墙 —— 而那是他对这个功能的第一印象。
 * 例子里出现的镜号和人名，全部取自他自己的分镜表。
 */
export function examplesFor(project = {}) {
  const shots = (project.shots || []).slice().sort((a, b) => a.index - b.index);
  const out = [];
  if (shots.length >= 2) {
    const lo = shots[0].index;
    const hi = shots[Math.min(shots.length, 3) - 1].index;
    out.push(lo === hi ? `第 ${lo} 镜改成中景` : `第 ${lo}-${hi} 镜改成中景`);
  }
  // 人名取出场次数最多的那个：例子里出现一个只演过一镜的配角没什么意义
  const tally = new Map();
  for (const s of shots) for (const c of s.characters || []) tally.set(c, (tally.get(c) || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) out.push(`有${top}的镜头加上仰拍`);
  const noImg = shots.find((s) => !s.imagePath);
  if (noImg) out.push(`第 ${noImg.index} 镜为什么没图`);
  if (shots.some((s) => s.imagePath && !s.videoPath)) out.push('把缺视频的都跑了');
  out.push('这一轮要花多少钱');
  return out;
}

/** 项目还没有分镜时的兜底。这几句在空项目里也不会指向不存在的镜头 */
export const EXAMPLES = ['这一轮要花多少钱', '看看现在跑到哪了'];
