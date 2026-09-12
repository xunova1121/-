/**
 * 按下去之前，这一下要发出去多少东西。
 *
 * ══════════ 预估和记账是两件事 ══════════
 *
 * ledger 记的是**已经发生的**，从响应里读出来，一个字不猜。
 * 这个文件算的是**还没发生的**，全靠推。两者绝不能混着显示，
 * 也绝不能用同一套措辞 —— "花了 ¥12" 和 "大概要花 ¥12" 差着一个数量级的确定性。
 *
 * ══════════ 哪些能推准，哪些推不准 ══════════
 *
 * 能推准的，恰好是花钱的那几步：
 *
 *   出图   缺图的镜数 × 1 张。就是这么多，误差只来自重试。
 *   出视频 每一镜的时长**对齐到厂商档位之后**求和。
 *          这里必须对齐 —— 分镜写 4 秒、厂商只出 5 秒档、按 5 秒计费，
 *          不对齐的话二十镜能少估四分之一。
 *   配音   台词的字数。数得出来，一个字不差。
 *
 * 推不准的，恰好是不太花钱的那一步：
 *
 *   拆分镜 / 大纲 / 一致性复核 —— 这些是对话调用，出多少 token 取决于
 *   模型话多话少，事前没法知道。**这里就明说算不出来**，不给一个
 *   看起来很精确的假数。它们在总账里通常只占零头，而一个编出来的
 *   零头会毁掉整个数字的可信度。
 *
 * ══════════ 为什么重试要单独说，不并进总数 ══════════
 *
 * 一致性复核不过关会重出，最多 consistencyMaxRetries 次。
 * 把最坏情况并进总数，得到的是一个**总是偏高**的数，人很快就学会不看它；
 * 完全不提，又会在重试真的发生时让账对不上。
 * 所以给两个数：`cny` 是不重试的情况，`worst` 是全都重试满的情况。
 * 界面说"约 ¥8，全都要重出的话最多 ¥24"—— 两头都是真的。
 *
 * ── 两端共用 ──
 * 浏览器从 /estimate.js 取这个文件的原文，所以只许 import ../pricing.js
 * 和 ../duration.js 这两个同样共用的模块。
 */
import * as pricing from '../pricing.js';
import { alignDuration } from '../duration.js';

/** 这一步要动哪些镜。和界面上"还差几镜"用的是同一套判断，不许各写一份。 */
export function pendingShots(shots = [], stage, { regenerate = false } = {}) {
  const all = (shots || []).filter(Boolean);
  if (regenerate) {
    if (stage === 'assets') return all;
    if (stage === 'video') return all.filter((s) => s.imagePath);
    if (stage === 'voice') return all.filter((s) => (s.dialogue || '').trim());
    return all;
  }
  if (stage === 'assets') return all.filter((s) => !s.imagePath);
  if (stage === 'video') return all.filter((s) => s.imagePath && !s.videoPath);
  if (stage === 'voice') return all.filter((s) => (s.dialogue || '').trim() && !s.audioPath);
  return [];
}

/** 台词有多少个字。和适配层计费用的是同一个口径（标点也算）。 */
export function dialogueChars(shot) {
  return [...String(shot?.dialogue ?? '')].length;
}

/**
 * 这一镜的视频会被按多少秒计费。
 *
 * `durations` 是这家厂商的合法档位；给空数组就按原样，
 * 但那只会发生在"还没选视频服务商"的时候 —— 那时候本来也估不出钱。
 */
export function billedSeconds(shot, durations = []) {
  const want = Number(shot?.duration) || 5;
  return durations.length ? alignDuration(want, durations) : want;
}

/**
 * 算一步的用量。
 *
 * routing 形如 `{ image: {provider, model}, video: {provider, model, durations}, tts: {...} }`,
 * 由调用方从当前设置解析好传进来 —— 这个文件不认识 settings，
 * 它要能在浏览器里跑。
 */
export function forStage({ shots = [], stage, routing = {}, regenerate = false, maxRetries = 0 } = {}) {
  const targets = pendingShots(shots, stage, { regenerate });
  const items = [];
  const retryItems = [];
  /** 说不准的那些步，单独列出来给界面明说，不掺进 items */
  const unpredictable = [];

  if (stage === 'assets') {
    const r = routing.image || {};
    if (targets.length) {
      items.push({ kind: 'image', provider: r.provider, model: r.model, units: targets.length, calls: targets.length });
      if (maxRetries > 0) {
        retryItems.push({ kind: 'image', provider: r.provider, model: r.model, units: targets.length * maxRetries, calls: targets.length * maxRetries });
      }
    }
  } else if (stage === 'video') {
    const r = routing.video || {};
    const seconds = targets.reduce((sum, s) => sum + billedSeconds(s, r.durations || []), 0);
    if (seconds > 0) items.push({ kind: 'video', provider: r.provider, model: r.model, units: seconds, calls: targets.length });
  } else if (stage === 'voice') {
    const r = routing.tts || {};
    const chars = targets.reduce((sum, s) => sum + dialogueChars(s), 0);
    if (chars > 0) items.push({ kind: 'tts', provider: r.provider, model: r.model, units: chars, calls: targets.length });
  } else if (stage === 'compose') {
    /**
     * 合成整步一分钱不花 —— 全是本机 FFmpeg。
     * 这一条必须显式说出来，因为它正好是用户最该知道的那一句：
     * 调节奏、换顺序、砍一镜，都在这一步里，都不要钱。
     */
    return { stage, shots: 0, items: [], retryItems: [], unpredictable: [], free: true };
  } else if (stage === 'script' || stage === 'bible' || stage === 'outline') {
    unpredictable.push(stage);
  }

  return { stage, shots: targets.length, items, retryItems, unpredictable, free: false };
}

/** 「往后全跑」：从某一步开始，把后面几步串起来估。 */
const ORDER = ['bible', 'script', 'assets', 'video', 'voice', 'compose'];

export function forRun({ shots = [], from = 'assets', routing = {}, maxRetries = 0 } = {}) {
  const start = Math.max(0, ORDER.indexOf(from));
  const stages = ORDER.slice(start);
  const items = [];
  const retryItems = [];
  const unpredictable = [];
  const perStage = [];

  for (const stage of stages) {
    /**
     * ⚠ 每一步都按**当前的镜况**估，这是个已知的偏保守之处：
     * 「往后全跑」里出图那步跑完，出视频那步面对的镜数会比现在多
     * （现在还没图的镜，跑完就有图了）。所以这里要按"跑完之后"来数 ——
     * 也就是出视频那步的目标是"所有镜"，不是"现在有图的镜"。
     * 不这么算的话，一个刚拆完分镜、一张图都没有的项目会估出
     * "出视频 0 秒"，而那是这一整趟里最贵的一步。
     */
    const asIfDone = stage === 'video' || stage === 'voice' ? shotsAsIfUpstreamDone(shots, stage, stages) : shots;
    const one = forStage({ shots: asIfDone, stage, routing, maxRetries });
    perStage.push(one);
    items.push(...one.items);
    retryItems.push(...one.retryItems);
    unpredictable.push(...one.unpredictable);
  }

  return { from, stages, items, retryItems, unpredictable, perStage };
}

/**
 * 上游步骤也在这一趟里的话，就当它已经跑完了。
 *
 * 只在"这一趟确实包含那一步"时才假设 —— 从 video 开始跑的时候，
 * 没图的镜是真的出不了视频，不该算进去。
 */
function shotsAsIfUpstreamDone(shots, stage, stages) {
  if (stage === 'video' && stages.includes('assets')) {
    return (shots || []).map((s) => ({ ...s, imagePath: s.imagePath || '(将出)' }));
  }
  return shots;
}

/**
 * 把一份估算折成钱。
 *
 * 返回里 `cny` 是不重试的情况，`worst` 是重试全用满。两个都给，
 * 界面自己决定说哪个 —— 但**不许只说 worst**，那会把每个数字都吓成天价。
 */
export function price(plan, rates = {}) {
  const base = pricing.sum(plan?.items || [], rates);
  const retry = pricing.sum([...(plan?.items || []), ...(plan?.retryItems || [])], rates);
  return {
    base,
    worst: (plan?.retryItems || []).length ? retry : null,
    unpredictable: [...new Set(plan?.unpredictable || [])],
    free: plan?.free === true
  };
}

const STAGE_LABEL = {
  bible: '出设定集',
  script: '拆分镜',
  outline: '出大纲',
  assets: '出图',
  video: '出视频',
  voice: '配音',
  compose: '合成'
};

/**
 * 一句话说清一次预估。
 *
 * 三种情况分开说，因为它们**是三种不同的真相**：
 *   什么都不用做  → 说清楚不用做，不要显示 ¥0（那看起来像"免费"）
 *   本来就不花钱  → 说"不花钱"，这是好消息，值得单独说
 *   要花钱        → 说用量 + 钱，没填单价就只说用量
 */
export function describe(plan, rates = {}) {
  if (plan?.free) return '这一步不花钱 —— 全在本机做（FFmpeg）';
  const priced = price(plan, rates);
  const total = priced.base;

  const hasWork = (plan?.items || []).length > 0;
  const notes = [];
  for (const s of priced.unpredictable) {
    notes.push(`${STAGE_LABEL[s] || s}要调大模型，出多少 token 事前算不出来，没算进去`);
  }

  if (!hasWork) {
    const tail = notes.length ? `（${notes.join('；')}）` : '';
    return notes.length ? `没有要出的东西${tail}` : '没有要出的东西 —— 这一步已经齐了';
  }

  let line = pricing.describeSum(total, { prefix: '这一下要发：' });
  if (priced.worst?.cny !== null && priced.worst?.cny !== undefined && total.cny !== null) {
    const worstMoney = pricing.fmtMoney(priced.worst.cny);
    if (worstMoney) line += `；一致性复核不过要重出，全重最多 ${worstMoney}`;
  }
  if (notes.length) line += `。另外 ${notes.join('；')}`;
  return line;
}

export { STAGE_LABEL, ORDER };
