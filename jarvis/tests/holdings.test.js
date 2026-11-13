import { describe, it, expect, beforeEach } from 'vitest';
import * as holdings from '../src/agent/holdings.js';
import { collection } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { buildContext } from '../src/agent/agent.js';
import { CORE } from '../src/agent/toolLoader.js';

// 2026-10-28 10:00 北京时间
const D28 = Date.UTC(2026, 9, 28, 2, 0);
const D29 = D28 + 86_400_000;

beforeEach(async () => {
  await collection('kv').delete('holdings');
});

describe('持仓链路：推荐 → 买入 → 更正成本 → 压缩后 → 次日盈亏', () => {
  it('推荐不算持仓；买入按成交价记；更正以用户为准并留旧值；次日按真实收盘算盈亏', async () => {
    // 未央推荐过 600000，但用户没说买：持仓里没有
    expect(await holdings.list()).toEqual([]);
    expect(holdings.holdingsBlock([])).toBe('');

    await holdings.record({ action: 'buy', code: '600000', name: '浦发银行', shares: 1000, price: 10.5 }, D28);
    // 用户：“成本记错了，实际是 10.38”
    const fixed = await holdings.record({ action: 'correct', code: '600000', cost: 10.38, note: '用户说实际成交 10.38' }, D28 + 3600_000);
    expect(fixed).toMatchObject({ code: '600000', shares: 1000, cost: 10.38, firstBuy: '2026-10-28' });
    expect(holdings.describeHolding(fixed)).toMatch(/成本 10\.5→10\.38/);

    // 长对话压缩 / 新开对话：不靠对话原文，持仓记录还在
    const [h] = await holdings.list();
    const r = holdings.profit(h, { price: 10.8, prevClose: 10.6 });
    expect(r).toEqual({ total: 420, pct: 4.05, day: 200, marketValue: 10800 });
  });

  it('加仓按股数加权算成本；卖出减仓，卖光算清仓', async () => {
    await holdings.record({ action: 'buy', code: '000001', shares: 100, price: 10 }, D28);
    const more = await holdings.record({ action: 'buy', code: '000001', shares: 300, price: 12 }, D28);
    expect(more).toMatchObject({ shares: 400, cost: 11.5 });
    const after = await holdings.record({ action: 'sell', code: '000001', shares: 400, price: 12.5 }, D29);
    expect(after.shares).toBe(0);
    expect(await holdings.list()).toEqual([]);
    expect(await holdings.list({ all: true })).toHaveLength(1);
  });

  it('A 股 T+1：当天买的当天不能卖；超出持仓、没有记录、无效输入都照实报错', async () => {
    await holdings.record({ action: 'buy', code: '600519', shares: 100, price: 1500 }, D28);
    await expect(holdings.record({ action: 'sell', code: '600519', shares: 100 }, D28)).rejects.toThrow(/T\+1/);
    await expect(holdings.record({ action: 'sell', code: '600519', shares: 200 }, D29)).rejects.toThrow(/超过/);
    await expect(holdings.record({ action: 'correct', code: '300750', cost: 200 }, D29)).rejects.toThrow(/没有 300750/);
    await expect(holdings.record({ action: 'buy', code: '6005', shares: 100, price: 1 }, D29)).rejects.toThrow(/六位/);
    await expect(holdings.record({ action: 'buy', code: '600519', shares: 0, price: 1 }, D29)).rejects.toThrow(/股数/);
    expect((await holdings.record({ action: 'sell', code: '600519', shares: 100 }, D29)).shares).toBe(0);
  });

  it('工具：记成交、列持仓、算盈亏给出算式；没持仓不编', async () => {
    const tools = createTools({});
    const tool = (n) => tools.find((t) => t.name === n);
    expect(await tool('list_holdings').run({})).toMatch(/没有股票/);
    expect(await tool('holding_profit').run({ code: '600000', price: 10, priceDate: '2026-10-29' })).toMatch(/算不了盈亏/);
    expect(await tool('record_holding').run({ action: 'buy', code: '600000', name: '浦发银行', shares: 1000, price: 10.5 })).toMatch(/已记下买入/);
    expect(await tool('record_holding').run({ action: 'correct', code: '600000', cost: 10.38 })).toMatch(/已按用户的话更正/);
    expect(await tool('list_holdings').run({})).toMatch(/600000 浦发银行：1000 股，成本 10\.38/);
    const out = await tool('holding_profit').run({ code: '600000', price: 10.8, prevClose: 10.6, priceDate: '2026-10-29' });
    expect(out).toMatch(/总盈亏 \+420 元（\+4\.05%），当日盈亏 \+200 元/);
    expect(out).toMatch(/（10\.8 − 10\.38）× 1000/);
    for (const n of ['record_holding', 'list_holdings', 'holding_profit']) expect(CORE.has(n)).toBe(true);
  });

  it('问到股票时上下文带持仓（压缩后也对得上），闲聊不带', async () => {
    await holdings.record({ action: 'buy', code: '600000', name: '浦发银行', shares: 1000, price: 10.38 }, D28);
    const stock = await buildContext('我那只股票今天赚了多少', {});
    expect(stock.dynamic).toContain('## 用户的持仓');
    expect(stock.dynamic).toContain('600000 浦发银行：1000 股，成本 10.38');
    expect(stock.dynamic).toContain('推荐价不是持仓也不是成本');
    const chat = await buildContext('今天天气怎么样', {});
    expect(chat.dynamic).not.toContain('## 用户的持仓');
  });
});
