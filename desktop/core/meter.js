/**
 * 计量：把一次调用的**真实用量**记到当前项目头上。
 *
 * ══════════ 为什么要一层"当前上下文" ══════════
 *
 * 记账要知道两件事：用了多少（适配层知道，它刚解析完响应），
 * 记到谁头上（流水线知道，它知道在跑哪个项目的哪一步）。
 * 这两处隔着十几层调用，中间那些函数一个都不关心项目 id。
 *
 * 把 projectId 顺着参数一路传下去，意味着改二十几个函数签名，
 * 而且**漏传一处就是静默丢账** —— 那一次调用照样发出去、照样花钱，
 * 只是没记上，而且没有任何地方会红。这个应用今天已经栽过两次
 * "在调用点手工登记"（modelUsed、refsSent 都是这么开始说谎的）。
 *
 * AsyncLocalStorage 让流水线在最外层圈一次，里面无论多深、
 * 无论 await 多少次，meter.record() 都自动落到对的项目上。
 * 它是 node: 内置的，不破坏"零依赖"。
 *
 * ══════════ 圈不到的地方会怎样 ══════════
 *
 * 联调台里手动发的请求、开机自检的探针，都在任何 runIn 之外 ——
 * 它们落到 `(未归属)` 那一栏里，照样有账，只是不算在某个项目上。
 * 这是对的：那些钱确实花了，但确实不属于哪部片子。
 *
 * ══════════ 记什么、不记什么 ══════════
 *
 * 只记**响应里读得出来的**。读不出来就 blind() 记一笔"漏了"，
 * 绝不拿请求里的打算去凑 —— 那正是 modelUsed 当初说谎的方式。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as ledger from './ledger.js';

const store = new AsyncLocalStorage();

/** 当前在跑谁的哪一步。没圈过就是空的。 */
export function current() {
  return store.getStore() || null;
}

/**
 * 在这个上下文里跑一段。嵌套时内层覆盖外层的 stage，projectId 沿用外层
 * （出图那一步内部还会调对话去写提示词，那笔账仍然是这个项目的）。
 */
export function runIn(ctx, fn) {
  const base = current() || {};
  const next = { ...base, ...ctx };
  if (!next.projectId) next.projectId = base.projectId || null;
  return store.run(next, fn);
}

/** 只换 stage，不动项目 —— 流水线一步一步往下走时用 */
export function stage(name, fn) {
  return runIn({ stage: name }, fn);
}

/**
 * 记一笔真实用量。
 *
 * units：token 传 `{in, out}`，其余传一个数（张 / 秒 / 字）。
 * taskId：异步任务（出视频）传上，失败时好冲账。
 */
export function record({ kind, provider, model, units, taskId = null, note = '' } = {}) {
  const ctx = current() || {};
  return ledger.add({
    projectId: ctx.projectId || null,
    stage: ctx.stage || '',
    provider,
    model,
    kind,
    units,
    taskId,
    note
  });
}

/** 这一次读不出用量。记住"漏了一次"和是谁漏的，不猜数。 */
export function blind({ kind, provider, model, why = '' } = {}) {
  const ctx = current() || {};
  return ledger.addUnmetered({ projectId: ctx.projectId || null, provider, model, kind, why });
}

/**
 * 从对话响应里读 token 用量。
 *
 * 各家字段名不统一，但都是**进/出两个数**。只认能拆开进出的形态 ——
 * 有的家只回一个 total_tokens，那个数拆不开：进和出的单价常常差 4 倍，
 * 全算成进会少算一半的钱，全算成出会多算一倍。两种都是假数，
 * 所以这里返回 null，交给调用方去 blind()。
 */
export function readTokenUsage(json) {
  const u = json?.usage || json?.output?.usage || json?.data?.usage || null;
  if (!u || typeof u !== 'object') return null;
  const inTok = firstNumber(u.prompt_tokens, u.input_tokens, u.inputTokens, u.prompt_token_count);
  const outTok = firstNumber(u.completion_tokens, u.output_tokens, u.outputTokens, u.completion_token_count);
  if (inTok === null || outTok === null) return null;
  return { in: inTok, out: outTok };
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * 这次响应里**真的**回来了几张图。
 *
 * 不是"我们要了几张"。要 4 张回 3 张的情况是有的（内容审核拦掉一张），
 * 厂商按回的算，我们也按回的算。
 */
export function countImages(json) {
  if (!json || typeof json !== 'object') return 0;
  for (const arr of [json.data, json.images, json.output?.results, json.output?.data, json.result?.images]) {
    if (Array.isArray(arr)) {
      return arr.filter((x) => x && (typeof x === 'string' || x.url || x.b64_json || x.base64 || x.image || x.b64)).length;
    }
  }
  return 0;
}

export { ledger };
