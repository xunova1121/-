import { expect, it, vi } from 'vitest';
import { completedStockCloses, createStockKlineTool } from '../src/agent/stockKline.js';
const rows = [['2026-10-26', 10, 11, 12, 9, 100], ['2026-10-27', 11, 12, 13, 10, 150], ['2026-10-28', 12, 13, 14, 11, 180]];
const afterClose = Date.parse('2026-10-28T16:00:00+08:00');
it('持仓三字段明确，limit=1仍可从同一来源取前收盘，不混日期/复权', async () => {
  const get = vi.fn(async () => new Response(JSON.stringify({ data: { sh600000: { day: rows } } })));
  const result = JSON.parse(await createStockKlineTool({ fetchImpl: get, now: () => afterClose }).run({ code: '600000', limit: 1 }));
  expect(result).toMatchObject({ latestClose: 13, previousClose: 12, priceDate: '2026-10-28', previousPriceDate: '2026-10-27', adjustment: 'none', holdingCompatible: true, priceState: 'completed_daily_bar' });
  expect(result.bars).toHaveLength(1);
  expect(decodeURIComponent(get.mock.calls[0][0])).toContain(',3,');
});
it('盘中与未来数据不作收盘，历史范围、缺少前日、新股单条记录都不猜', () => {
  expect(completedStockCloses(rows, { now: Date.parse('2026-10-28T14:00:00+08:00') })).toMatchObject({ latestClose: 12, previousClose: 11, priceDate: '2026-10-27' });
  expect(completedStockCloses(rows, { end: '2026-10-26', now: afterClose })).toMatchObject({ latestClose: 11, previousClose: null, priceDate: '2026-10-26', previousPriceDate: null });
  expect(completedStockCloses([rows.at(-1)], { now: Date.parse('2026-10-28T14:00:00+08:00') })).toMatchObject({ latestClose: null, priceDate: null, holdingCompatible: false });
  expect(completedStockCloses([rows.at(-1)], { now: afterClose })).toMatchObject({ latestClose: 13, previousClose: null });
  expect(completedStockCloses(rows, { adjustment: 'qfq', now: afterClose }).holdingCompatible).toBe(false);
});
it('腾讯失败后新浪回执字段/日期/未复权口径一致，记录失败来源且不混两家价格', async () => {
  const objects = rows.map(([date, open, close, high, low, volume]) => ({ day: date, open, close, high, low, volume }));
  const get = vi.fn(async url => url.includes('gtimg') ? new Response('unavailable', { status: 503 }) : new Response('var _k=(' + JSON.stringify(objects) + ');'));
  const result = JSON.parse(await createStockKlineTool({ fetchImpl: get, now: () => afterClose }).run({ code: '600000' }));
  expect(result).toMatchObject({ source: '新浪行情', latestClose: 13, previousClose: 12, priceDate: '2026-10-28', adjustment: 'none', holdingCompatible: true });
  expect(result.failedSources).toEqual([{ source: '腾讯行情', code: 'HTTP_ERROR' }]);
  expect(get).toHaveBeenCalledTimes(2);
});
it('预算和停止不被备用源吞掉', async () => {
  const get = vi.fn();
  await expect(createStockKlineTool({ fetchImpl: get }).run({ code: '600000' }, { retrieval: { consume: () => { throw Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' }); } } })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
  expect(get).not.toHaveBeenCalled();
});
