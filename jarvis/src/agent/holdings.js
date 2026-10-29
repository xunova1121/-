/**
 * 用户的持仓记录：推荐 → 买入 → 更正成本 → 次日盈亏，前后对得上。
 *
 *   - 只记用户亲口说的成交（“我买了 / 成交了 / 成本是…”）；未央推荐过的股票、推荐价都不是持仓和成本
 *   - 用户更正成本、股数时以用户的为准，旧值留在 history 里，能说清“从多少改成了多少”
 *   - 存在 kv 里，不靠对话原文：长对话压缩成摘要、换了新对话、换了设备（服务器模式）都还在
 *   - 盈亏由程序算：（现价 − 成本）× 股数；当日盈亏用（现价 − 昨收）× 股数。现价要来自行情工具（get_stock_kline），
 *     没有行情就不算，不拿旧收盘冒充今天
 *   - A 股 T+1：当天买的当天不能卖
 */
import { collection, uid } from './store.js';

const kv = collection('kv');
const KEY = 'holdings';
const BJ = 8 * 3600_000;
/** 北京时间的日期 YYYY-MM-DD */
export const bjDate = (t = Date.now()) => new Date(t + BJ).toISOString().slice(0, 10);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const invalid = (message) => Object.assign(new Error(message), { code: 'HOLDING_INPUT', kind: 'input' });

export async function list({ all = false } = {}) {
  const items = (await kv.get(KEY))?.items ?? [];
  return all ? items : items.filter((h) => h.shares > 0);
}
async function saveAll(items) {
  await kv.put({ id: KEY, items });
}

const code6 = (code) => {
  const c = String(code ?? '').replace(/\D/g, '');
  if (c.length !== 6) throw invalid('证券代码要六位数字，例如 600519');
  return c;
};
const positive = (n, what) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) throw invalid(`${what}要大于 0`);
  return v;
};
const dayOf = (date, now) => {
  if (!date) return bjDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw invalid('日期写成 YYYY-MM-DD');
  return String(date);
};

/**
 * 记一笔用户说的操作。
 * @param {{ action: 'buy'|'sell'|'correct', code: string, name?: string, shares?: number, price?: number, cost?: number, date?: string, note?: string }} t
 *   buy：按成交价加仓（已有持仓时按股数加权算新成本）；sell：减仓；correct：把成本 / 股数改成用户说的值
 */
export async function record(t, now = Date.now()) {
  const items = await list({ all: true });
  const code = code6(t.code);
  const date = dayOf(t.date, now);
  let h = items.find((x) => x.code === code && x.shares > 0);
  const log = (entry) => h.history.push({ at: now, date, ...entry, ...(t.note && { note: String(t.note).slice(0, 120) }) });
  if (t.action === 'buy') {
    const shares = positive(t.shares, '股数');
    const price = positive(t.price ?? t.cost, '成交价');
    if (!h) {
      h = { id: uid('hold'), code, name: String(t.name || '').slice(0, 20), shares: 0, cost: 0, firstBuy: date, lastBuy: date, history: [] };
      items.push(h);
    }
    const total = h.shares + shares;
    h.cost = round((h.cost * h.shares + price * shares) / total, 4);
    h.shares = total;
    h.lastBuy = date;
    if (t.name) h.name = String(t.name).slice(0, 20);
    log({ action: 'buy', shares, price });
  } else if (t.action === 'sell') {
    if (!h) throw invalid(`没有 ${code} 的持仓记录，先确认用户是否买过、代码是否正确`);
    const shares = positive(t.shares, '股数');
    if (shares > h.shares) throw invalid(`卖出 ${shares} 股超过记录的持仓 ${h.shares} 股`);
    // T+1：当天新买的那部分当天不能卖；整笔持仓都是今天买的就整笔不能卖
    const boughtToday = h.history.filter((e) => e.action === 'buy' && e.date === date).reduce((s, e) => s + e.shares, 0);
    if (shares > h.shares - boughtToday) throw invalid(`A 股 T+1：${date} 当天买入的 ${boughtToday} 股当天不能卖，今天最多可卖 ${h.shares - boughtToday} 股`);
    h.shares -= shares;
    log({ action: 'sell', shares, price: t.price ? Number(t.price) : null });
  } else if (t.action === 'correct') {
    if (!h) throw invalid(`没有 ${code} 的持仓记录；用户是第一次说这笔成交的话，用 action: buy 记下`);
    const before = { cost: h.cost, shares: h.shares };
    if (t.cost !== undefined && t.cost !== null) h.cost = round(positive(t.cost, '成本'), 4);
    if (t.shares !== undefined && t.shares !== null) h.shares = positive(t.shares, '股数');
    if (t.name) h.name = String(t.name).slice(0, 20);
    if (before.cost === h.cost && before.shares === h.shares) throw invalid('成本和股数都没有变化');
    log({ action: 'correct', before, after: { cost: h.cost, shares: h.shares } });
  } else throw invalid('action 只能是 buy / sell / correct');
  h.updatedAt = now;
  await saveAll(items);
  return { ...h };
}

/**
 * 按现价算盈亏（程序算，不让模型心算）
 * @param {{ shares: number, cost: number }} h
 * @param {{ price: number, prevClose?: number }} quote
 */
export function profit(h, { price, prevClose } = {}) {
  const p = positive(price, '现价');
  const total = round((p - h.cost) * h.shares);
  const pct = round(((p - h.cost) / h.cost) * 100);
  const day = prevClose ? round((p - Number(prevClose)) * h.shares) : null;
  return { total, pct, day, marketValue: round(p * h.shares) };
}

const fmt = (n) => (n > 0 ? `+${n}` : String(n));
const lastCorrection = (h) => [...(h.history || [])].reverse().find((e) => e.action === 'correct');
/** 一条持仓的人话描述 */
export function describeHolding(h) {
  const fix = lastCorrection(h);
  return `${h.code}${h.name ? ` ${h.name}` : ''}：${h.shares} 股，成本 ${h.cost}（首次买入 ${h.firstBuy}${fix ? `；${fix.date} 用户更正：成本 ${fix.before.cost}→${fix.after.cost}，股数 ${fix.before.shares}→${fix.after.shares}` : ''}）`;
}

/** 放进上下文的持仓段：只在问到股票时带上（见 agent.js） */
export function holdingsBlock(items = []) {
  if (!items.length) return '';
  return `## 用户的持仓（用户亲口说过的成交和更正，存在持仓记录里，长对话压缩后也以此为准；你推荐过的股票和推荐价不是持仓也不是成本）\n${items.map((h) => `- ${describeHolding(h)}`).join('\n')}\n算盈亏：先用 get_stock_kline（adjustment=none）取回执里的 latestClose / previousClose / priceDate，再调 holding_profit（price=latestClose，prevClose=previousClose，priceDate），不要心算；latestClose 为 null 就是还没有已收盘的价格，没取到行情就说没有，不拿旧价格当今天。用户说买了 / 卖了 / 成本不对时用 record_holding 记下。`;
}

export const STOCK_TOPIC = /股票|持仓|证券|股价|行情|盈亏|赚了|亏了|收益|涨停|跌停|K线|A股|买入|卖出|买了|卖了|成本|仓位/i;

export function createHoldingTools() {
  const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    {
      name: 'record_holding',
      description: '记下用户亲口说的股票成交或更正：“我买了 / 成交了”用 buy（成交价、股数），“卖了”用 sell，“成本不对 / 实际成本是 / 股数记错了”用 correct。只记用户说的，你推荐过的股票不是持仓，推荐价不是成本；用户没说股数或价格就先问，不要猜。',
      input_schema: S(
        {
          action: { type: 'string', enum: ['buy', 'sell', 'correct'] },
          code: { type: 'string', description: '六位证券代码' },
          name: { type: 'string', description: '股票名称（可选）' },
          shares: { type: 'number', description: '股数（buy / sell 必填；correct 时填更正后的总股数，不改就不填）' },
          price: { type: 'number', description: '成交价（buy / sell）' },
          cost: { type: 'number', description: '更正后的每股成本（correct）' },
          date: { type: 'string', description: '成交日期 YYYY-MM-DD（北京时间），不填就是今天' },
          note: { type: 'string', description: '用户原话摘要（可选）' }
        },
        ['action', 'code']
      ),
      run: async (args) => {
        const h = await record(args);
        const verb = { buy: '已记下买入', sell: '已记下卖出', correct: '已按用户的话更正' }[args.action];
        return `${verb}。现在：${describeHolding(h)}${h.shares === 0 ? '（已清仓）' : ''}`;
      }
    },
    {
      name: 'list_holdings',
      description: '列出用户的持仓记录（代码、股数、成本、买入日期、更正记录）。问持仓、盈亏、要不要卖之前先看这里，不凭聊天记录或摘要回忆。',
      input_schema: S({}),
      run: async () => {
        const items = await list();
        return items.length ? items.map((h) => `- ${describeHolding(h)}`).join('\n') : '持仓记录里没有股票。用户说过买入的话，用 record_holding 补记（要有股数和成交价）。';
      }
    },
    {
      name: 'holding_profit',
      description: '按持仓记录算盈亏：总盈亏 =（现价 − 成本）× 股数，当日盈亏 =（现价 − 昨收）× 股数。现价、昨收用 get_stock_kline 取到的真实数据，并写明是哪天的收盘。',
      input_schema: S(
        {
          code: { type: 'string', description: '六位证券代码' },
          price: { type: 'number', description: '现价或最新收盘价（来自行情工具）' },
          prevClose: { type: 'number', description: '前一交易日收盘价（算当日盈亏用，可选）' },
          priceDate: { type: 'string', description: '价格对应的交易日 YYYY-MM-DD' }
        },
        ['code', 'price', 'priceDate']
      ),
      run: async ({ code, price, prevClose, priceDate }) => {
        const h = (await list()).find((x) => x.code === code6(code));
        if (!h) return `持仓记录里没有 ${code}，算不了盈亏；先确认用户是否买过（record_holding）。`;
        const r = profit(h, { price, prevClose });
        return `${describeHolding(h)}\n按 ${priceDate} 价格 ${price}${prevClose ? `、昨收 ${prevClose}` : ''}：市值 ${r.marketValue} 元，总盈亏 ${fmt(r.total)} 元（${fmt(r.pct)}%）${r.day === null ? '' : `，当日盈亏 ${fmt(r.day)} 元`}。算式：（${price} − ${h.cost}）× ${h.shares}${r.day === null ? '' : `；（${price} − ${prevClose}）× ${h.shares}`}。`;
      }
    }
  ];
}
