import { describe, expect, it, vi } from 'vitest';
import { MARKET_SNAPSHOT_BYTES, mergeMarketSnapshots, normalizeMarketSnapshot } from '../shared/marketSnapshot.js';
import { createMarketQuoteTool } from '../src/agent/marketQuote.js';
import { createStockKlineTool } from '../src/agent/stockKline.js';
import { createTurnEvents } from '../src/app/turnEvents.js';
vi.mock('../src/app/env.js', () => ({ now: () => performance.now(), storage: {}, toast: vi.fn(), markActivity: vi.fn() }));

const from = { name: '测试行情源', url: 'https://quote.example/market' };
const stamp = Date.parse('2026-11-12T10:00:00Z');
const quote = (symbol = 'sh600519') => ({ version: 1, kind: 'quote', title: '行情', fetchedAt: stamp, quotes: [{ symbol, name: '测试公司', price: 1500, unit: '元', time: '2026-11-11 15:00:00', source: from }] });
const kline = () => ({ version: 1, kind: 'kline', title: '日K', fetchedAt: stamp, symbol: 'sh600519', source: from, unit: '元', adjustment: 'none', bars: [{ date: '2026-11-10', close: 10, open: 9, volume: 100 }, { date: '2026-11-11', close: 12, open: 10, volume: 200 }] });
const line = () => {
  const f = Array(50).fill('');
  Object.assign(f, { 1: '测试公司', 3: '1500', 4: '1500', 5: '1500', 30: '20261111150000', 31: '0', 32: '0', 33: '1500', 34: '1500' });
  return `v_sh600519="${f.join('~')}";`;
};
describe('行情卡有界可信快照', () => {
  it('只保留真实绘图必要字段，行情日不取查询时间替代；未知涨跌不变成0', () => {
    const value = quote(); value.quotes[0].change = null; value.secret = '不要存';
    expect(normalizeMarketSnapshot(value)).not.toHaveProperty('secret');
    expect(normalizeMarketSnapshot(value).quotes[0]).not.toHaveProperty('change');
    expect(normalizeMarketSnapshot(value).quotes[0].time).toBe('2026-11-11 15:00:00');
    expect(normalizeMarketSnapshot(kline()).bars).toEqual([{ date: '2026-11-10', close: 10 }, { date: '2026-11-11', close: 12 }]);
    value.quotes[0].time = null;
    expect(normalizeMarketSnapshot(value).quotes[0].time).toBe('');
  });
  it('拒绝假日期、重复日期、非数值价格、危险来源和未知卡类型', () => {
    for (const close of [null, '12', Infinity, -1]) {
      const value = kline(); value.bars[0].close = close;
      expect(normalizeMarketSnapshot(value)).toBeNull();
    }
    for (const date of ['2026-02-30', 'today', '2026-11-11']) {
      const value = kline(); value.bars[0].date = date;
      expect(normalizeMarketSnapshot(value)).toBeNull();
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://key:secret@example.org/']) {
      const value = quote(); value.quotes[0].source = { name: 'bad', url };
      expect(normalizeMarketSnapshot(value)).toBeNull();
    }
    expect(normalizeMarketSnapshot({ ...kline(), kind: 'image' })).toBeNull();
    expect(normalizeMarketSnapshot({ ...kline(), fetchedAt: Infinity })).toBeNull();
  });
  it('最多60个原始点，不插值补点；同证券刷新替换且迟到旧回执不能覆盖新价', () => {
    const value = kline();
    value.bars = Array.from({ length: 120 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close: i + 1 }));
    const clean = normalizeMarketSnapshot(value);
    expect(clean.bars).toHaveLength(60); expect(clean.bars[0].close).toBe(61); expect(clean.bars.at(-1).close).toBe(120);
    const first = quote(); const fresh = quote(); fresh.fetchedAt += 1000; fresh.quotes[0].price = 1600;
    const next = mergeMarketSnapshots([first], fresh);
    expect(next).toHaveLength(1); expect(next[0].quotes[0].price).toBe(1600);
    expect(mergeMarketSnapshots(next, first)).toEqual(next);
    expect(first.quotes[0].price).toBe(1500);
  });
  it('全轮最多4卡且包括中文UTF8始终≤16KiB，保留最新可用卡', () => {
    let cards = [];
    for (let i = 0; i < 12; i++) {
      const value = quote('sh' + i);
      value.quotes = Array.from({ length: 8 }, (_, j) => ({ ...value.quotes[0], name: '行情中文'.repeat(20), symbol: 'sh' + i + j, source: { name: '源'.repeat(64), url: 'https://quote.example/' + 'x'.repeat(400) } }));
      cards = mergeMarketSnapshots(cards, value);
      expect(cards.length).toBeLessThanOrEqual(4);
      expect(new TextEncoder().encode(JSON.stringify(cards)).length).toBeLessThanOrEqual(MARKET_SNAPSHOT_BYTES);
    }
    expect(cards.at(-1).quotes[0].symbol).toBe('sh110');
  });
  it('真实报价成功才发卡，原回执保持不变；取消和失败不发卡', async () => {
    const onMarketQuote = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(line()));
    const tool = createMarketQuoteTool({ onMarketQuote, fetchImpl, now: () => stamp });
    expect(await tool.run({ target: 'sh600519' })).toContain('测试公司（sh600519）：1500 元');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onMarketQuote).toHaveBeenCalledTimes(1);
    expect(onMarketQuote.mock.calls[0][0].quotes[0]).toMatchObject({ price: 1500, time: '2026-11-11 15:00:00', source: { name: '腾讯行情', url: 'https://qt.gtimg.cn/q=sh600519' } });
    onMarketQuote.mockClear();
    const ctrl = new AbortController();
    const cancelled = createMarketQuoteTool({ onMarketQuote, fetchImpl: async () => { ctrl.abort(); return new Response(line()); } });
    await expect(cancelled.run({ target: 'sh600519' }, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const failed = createMarketQuoteTool({ onMarketQuote, fetchImpl: async () => new Response('v_none="";') });
    await expect(failed.run({ target: 'sh600519' })).rejects.toMatchObject({ code: 'NO_MARKET_DATA' });
    expect(onMarketQuote).not.toHaveBeenCalled();
  });
  it('日K原工具输出完整OHLC，卡只取已返回的真实收盘序列，取消不发布', async () => {
    const onMarketQuote = vi.fn();
    const body = { data: { sh600519: { day: [['2026-11-10', 9, 10, 11, 8, 100], ['2026-11-11', 10, 12, 13, 9, 200]] } } };
    const tool = createStockKlineTool({ onMarketQuote, fetchImpl: async () => Response.json(body) });
    const result = JSON.parse(await tool.run({ code: '600519', limit: 2 }));
    expect(result.bars[0]).toMatchObject({ open: 9, high: 11, low: 8, volume: 100 });
    expect(onMarketQuote.mock.calls[0][0].bars).toEqual([{ date: '2026-11-10', close: 10 }, { date: '2026-11-11', close: 12 }]);
    onMarketQuote.mockClear(); const ctrl = new AbortController();
    const stopped = createStockKlineTool({ onMarketQuote, fetchImpl: async () => { ctrl.abort(); return Response.json(body); } });
    await expect(stopped.run({ code: '600519' }, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(onMarketQuote).not.toHaveBeenCalled();
  });
  it('卡片监听失败不重复读行情、不把成功数据误判为来源故障', async () => {
    const onMarketQuote = () => { throw Error('UI unavailable'); };
    const quoteFetch = vi.fn(async () => new Response(line()));
    expect(await createMarketQuoteTool({ onMarketQuote, fetchImpl: quoteFetch }).run({ target: 'sh600519' })).toContain('1500 元');
    expect(quoteFetch).toHaveBeenCalledTimes(1);
    const barFetch = vi.fn(async () => Response.json({ data: { sh600519: { day: [['2026-11-11', 10, 12, 13, 9, 200]] } } }));
    expect(JSON.parse(await createStockKlineTool({ onMarketQuote, fetchImpl: barFetch }).run({ code: '600519' })).bars[0].close).toBe(12);
    expect(barFetch).toHaveBeenCalledTimes(1);
  });
  it('前台、后台只更新原轮气泡，取消/已结束/失去归属的迟到事件不写入', () => {
    const app = {}, turn = { ctrl: new AbortController(), streamDone: false, background: false };
    app.active = turn;
    const bubble = { marketCards: vi.fn() };
    const emit = createTurnEvents(app).turnEvents(turn, {}, { bubble });
    emit({ type: 'market_quote', value: quote() });
    expect(bubble.marketCards).toHaveBeenCalledTimes(1);
    app.active = {}; emit({ type: 'market_quote', value: quote('sh1') });
    expect(turn.markets).toHaveLength(1);
    turn.background = true; emit({ type: 'market_quote', value: quote('sh2') });
    expect(turn.markets).toHaveLength(2);
    turn.ctrl.abort(); emit({ type: 'market_quote', value: quote('sh3') });
    expect(turn.markets).toHaveLength(2);
  });
});
