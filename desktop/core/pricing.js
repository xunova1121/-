/**
 * 用量与花费的换算。
 *
 * ══════════ 为什么这个文件里一个厂商价格都没有 ══════════
 *
 * 界面里到处在讲钱："视频这一步是最大的一笔开销""重出图和重配音差着几十倍"
 * "改这一样要付多少代价"。话全说了，数一个没有 —— 用户点「往后全跑」的时候，
 * 我们比他还不知道这一下要花多少。
 *
 * 补这个洞最容易想到的做法是**内置一张价目表**。我没有那么做，理由有三条，
 * 每一条单独拿出来都够：
 *
 *   1. 我不知道。各家单价我只有个印象，印象写进代码就变成了断言。
 *      这个应用里已经栽过两次"记录的是意图不是事实"（modelUsed、refsSent），
 *      内置一张我自己都不确信的价目表是同一种病，而且这次骗的是钱。
 *
 *   2. 就算今天抄对了，明天也会错。厂商调价、促销、阶梯计费、缓存命中折扣，
 *      都不通知任何人。一张三个月没人碰的表比没有表更糟 —— 没有表的时候
 *      用户知道自己不知道，有一张过期的表他以为自己知道。
 *
 *   3. **标价根本不是他的价。** 有额度包的、有企业协议的、走中转的，
 *      单价能差一倍以上。抄来的公开标价对他反而没用。
 *
 * ══════════ 所以分成两半 ══════════
 *
 *   用量（units）  我们的事实。几张图、多少秒视频、多少 token、多少字。
 *                  这些是从**响应体里读出来的**，不是下单时的打算 ——
 *                  发了 12 张回来 11 张，记的就是 11。永远记，永远显示。
 *
 *   单价（rates）   厂商的事实，由用户从自己的账单/价目表填进来。
 *                  没填就是没填 —— 显示成「还没填单价」，不是显示成 0。
 *
 * 于是没填单价的人也立刻拿到东西："这一次要发 12 张图、约 60 秒视频、
 * 8000 字配音"，这已经比什么都不说强得多，而且**一个字都不是编的**。
 * 填了单价的人拿到的是他自己的真钱，不是我抄来的标价。
 *
 * ══════════ 为什么 0 是危险值 ══════════
 *
 * 这个模块里所有"没有单价"的返回值都是 `null`，从来不是 `0`。
 * 一旦某处把未知当成 0 参与求和，总价就会是一个**看起来正常的偏小的数** ——
 * 那比不显示恶劣得多：用户会照着它做决定。sum() 因此把未定价的项
 * 单独装在 unpriced 里带出去，调用方必须显式处理，没法假装没看见。
 *
 * ── 这个文件两端共用 ──
 * 界面上那句"这一下大概多少钱"和服务端记的账必须是同一套算法。
 * 浏览器从 /pricing.js 直接取这个文件的原文，所以这里不许 import 任何东西。
 */

/**
 * 五种计费口径。
 *
 * `per` 是"单价按多少个单位报"—— 各家价目表的习惯口径，照抄能少一次心算：
 * token 论百万、配音论万字、图论张、视频论秒。填单价的人对着账单抄，
 * 抄进来就是对的；换算在这里做，不在他脑子里做。
 */
export const KINDS = {
  token: { label: '对话', per: 1000000, unit: 'token', priceUnit: '元 / 百万 token', pair: true },
  image: { label: '出图', per: 1, unit: '张', priceUnit: '元 / 张' },
  video: { label: '出视频', per: 1, unit: '秒', priceUnit: '元 / 秒' },
  tts: { label: '配音', per: 10000, unit: '字', priceUnit: '元 / 万字' },
  sfx: { label: '音效', per: 1, unit: '秒', priceUnit: '元 / 秒' }
};

export const KIND_IDS = Object.keys(KINDS);

export function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

/** 单价表的键。模型留空的走厂商级兜底 —— 一家只用一个模型的人不用逐个填。 */
export function rateKey(provider, model, kind) {
  return `${provider || '?'}:${model || '*'}:${kind || '?'}`;
}

/**
 * 找单价。
 *
 * 精确 → 厂商兜底，两级。**不做模糊前缀匹配**：
 * `doubao-seedream-4-0` 和 `doubao-seedream-3-0` 前缀一大半是一样的，
 * 让前缀去猜，等于把"你填的 3.0 的价"悄悄用在 4.0 上，而两者价钱不一样。
 * 猜错一个价钱，比承认不知道要坏。
 */
/**
 * 跑在自己机器上的那些，厂商侧单价确实是 0。
 *
 * 这**不是**我替厂商填的价，是"没有厂商"这个事实 —— 本地 ComfyUI、
 * 本地 Ollama 花的是电和显卡，不产生任何账单。
 * 不写这一条的话，用本地出图的人会被永远挂着一条"还没填单价"，
 * 而他去哪儿都找不到一个价目表可以抄。
 */
export const LOCAL_PROVIDERS = new Set(['comfy', 'ollama']);

export function rateFor(provider, model, kind, rates = {}) {
  if (LOCAL_PROVIDERS.has(provider)) return { cny: 0, in: 0, out: 0, matched: 'local', local: true };
  const exact = rates[rateKey(provider, model, kind)];
  if (isUsableRate(exact, kind)) return { ...exact, matched: 'model' };
  const byProvider = rates[rateKey(provider, '', kind)];
  if (isUsableRate(byProvider, kind)) return { ...byProvider, matched: 'provider' };
  return null;
}

function isUsableRate(r, kind) {
  if (!r || typeof r !== 'object') return false;
  if (KINDS[kind]?.pair) {
    return Number.isFinite(Number(r.in)) && Number.isFinite(Number(r.out)) && Number(r.in) >= 0 && Number(r.out) >= 0;
  }
  return Number.isFinite(Number(r.cny)) && Number(r.cny) >= 0;
}

/**
 * 一条用量值多少钱。没有单价返回 `{ cny: null }` —— 不是 0，见文件头。
 *
 * token 的 units 是 `{ in, out }` 两个数；其余是一个数。
 */
export function priceOne(item, rates = {}) {
  const kind = item?.kind;
  if (!isKind(kind)) return { cny: null, rate: null, reason: 'unknown-kind' };
  const rate = rateFor(item.provider, item.model, kind, rates);
  if (!rate) return { cny: null, rate: null, reason: 'no-rate' };

  const spec = KINDS[kind];
  if (spec.pair) {
    const cin = num(item.units?.in);
    const cout = num(item.units?.out);
    if (cin === null || cout === null) return { cny: null, rate, reason: 'no-units' };
    return { cny: (cin * Number(rate.in) + cout * Number(rate.out)) / spec.per, rate, reason: null };
  }
  const n = num(item.units);
  if (n === null) return { cny: null, rate, reason: 'no-units' };
  return { cny: (n * Number(rate.cny)) / spec.per, rate, reason: null };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 一批用量合计。
 *
 * 返回的 `cny` 只包含**算得出来的那些**，未定价的一律进 unpriced ——
 * 调用方必须自己决定怎么说这件事。把 cny 直接当成"总花费"显示是错的，
 * 有 unpriced 的时候它是**下限**，界面必须说清楚（sum 里给了 partial 标志）。
 */
export function sum(items = [], rates = {}) {
  let cny = 0;
  let pricedCount = 0;
  const unpriced = [];
  const byKind = {};

  for (const item of items) {
    if (!item || !isKind(item.kind)) continue;
    const bucket = (byKind[item.kind] ||= KINDS[item.kind].pair
      ? { units: { in: 0, out: 0 }, cny: 0, calls: 0, priced: 0 }
      : { units: 0, cny: 0, calls: 0, priced: 0 });
    bucket.calls += item.calls ?? 1;
    if (KINDS[item.kind].pair) {
      bucket.units.in += num(item.units?.in) || 0;
      bucket.units.out += num(item.units?.out) || 0;
    } else {
      bucket.units += num(item.units) || 0;
    }

    const got = priceOne(item, rates);
    if (got.cny === null) {
      unpriced.push({ provider: item.provider, model: item.model, kind: item.kind, reason: got.reason });
    } else {
      cny += got.cny;
      bucket.cny += got.cny;
      bucket.priced += item.calls ?? 1;
      pricedCount += 1;
    }
  }

  return {
    cny: pricedCount ? cny : null,
    partial: unpriced.length > 0 && pricedCount > 0,
    priced: pricedCount,
    unpriced,
    /** 去重后的"还差哪些单价"，界面照着这个列表让人去填 */
    missing: distinctMissing(unpriced),
    byKind
  };
}

function distinctMissing(unpriced) {
  const seen = new Map();
  for (const u of unpriced) {
    if (u.reason !== 'no-rate') continue;
    const key = rateKey(u.provider, u.model, u.kind);
    if (!seen.has(key)) seen.set(key, { key, provider: u.provider, model: u.model, kind: u.kind, hits: 0 });
    seen.get(key).hits += 1;
  }
  return [...seen.values()].sort((a, b) => b.hits - a.hits);
}

// ──────────────────────────────── 显示 ────────────────────────────────

/**
 * 把用量说成人话。
 *
 * token 上万就换成 k，不然一屏全是七位数，看不出哪个大哪个小。
 */
export function describeUnits(kind, units) {
  if (!isKind(kind)) return '';
  if (KINDS[kind].pair) {
    const i = num(units?.in) || 0;
    const o = num(units?.out) || 0;
    return `进 ${compact(i)} / 出 ${compact(o)} token`;
  }
  const n = num(units) || 0;
  const spec = KINDS[kind];
  if (kind === 'tts') return `${compact(n)} 字`;
  if (kind === 'video' || kind === 'sfx') return `${round(n, 1)} 秒`;
  return `${round(n, 0)} ${spec.unit}`;
}

function compact(n) {
  if (n >= 10000) return `${round(n / 10000, 1)} 万`;
  if (n >= 1000) return `${round(n / 1000, 1)}k`;
  return String(Math.round(n));
}

function round(n, digits) {
  const p = 10 ** digits;
  return String(Math.round(n * p) / p);
}

/**
 * 钱怎么写。
 *
 * 小额多给两位小数：一张图三分钱，写成「¥0.03」有意义，写成「¥0」没有 ——
 * 而"没有"正好是这个功能要消灭的东西。
 */
export function fmtMoney(cny) {
  if (cny === null || cny === undefined || !Number.isFinite(Number(cny))) return null;
  const n = Number(cny);
  if (n === 0) return '¥0';
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(3)}`;
  if (n < 100) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(1)}`;
}

/**
 * 一句话说清一笔合计 —— 有单价说钱，没单价说用量，从不含糊。
 *
 * 三种说法对应三种真实状态，界面直接用，省得每处自己拼（拼歪一处，
 * 就会出现"总共 ¥3.2"而其实有一半没算进去的那种句子）。
 */
export function describeSum(total, { prefix = '' } = {}) {
  const parts = [];
  for (const kind of KIND_IDS) {
    const b = total?.byKind?.[kind];
    if (!b || !b.calls) continue;
    parts.push(`${KINDS[kind].label} ${describeUnits(kind, b.units)}`);
  }
  const usage = parts.join('、') || '没有用量';

  if (total?.cny === null || total?.cny === undefined) {
    return `${prefix}${usage} —— 还没填单价，算不出钱`;
  }
  const money = fmtMoney(total.cny);
  if (total.partial) {
    const n = total.missing.length;
    return `${prefix}${usage} —— 至少 ${money}（还有 ${n} 个模型没填单价，没算进去）`;
  }
  return `${prefix}${usage} —— ${money}`;
}

export function describeMissing(m) {
  const kind = KINDS[m?.kind]?.label || m?.kind || '';
  const who = m?.model && m.model !== '*' ? `${m.provider} / ${m.model}` : `${m?.provider} 全部模型`;
  return `${who}（${kind}，${KINDS[m?.kind]?.priceUnit || ''}）`;
}
