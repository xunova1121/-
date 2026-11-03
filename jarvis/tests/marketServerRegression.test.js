import { it, expect, vi } from 'vitest';
import { createMarketQuoteTool, parseEastQuote, parseTencentQuote, parseTencentSuggest } from '../src/agent/marketQuote.js';

// 用户2026-11-03国内服务器提供的公开响应；是固定回归夹具，不冒充本次联网行情。
it('国内服务器实际腾讯字段、Unicode证券名及东方财富最小返回可以解析', () => {
  const text = 'v_sh600519="1~贵州茅台~600519~1480.00~1439.10~1450.00~74121~46430~27691~1479.99~9~1479.86~1~1479.83~2~1479.80~3~1479.60~2~1480.00~398~1480.01~1~1480.03~179~1480.04~1~1480.05~50~~20261103155241~40.90~2.84~1480.00~1435.10~1480.00/74121/10825780463"';
  expect(parseTencentQuote(text)[0]).toMatchObject({ name: '贵州茅台', price: 1480, prevClose: 1439.1, change: 40.9, changePct: 2.84, time: '2026-11-03 15:52:41' });
  expect(parseTencentSuggest('v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A"')[0]).toMatchObject({ symbol: 'sh600519', name: '贵州茅台' });
  expect(parseEastQuote('{"rc":0,"data":{"f43":840.01,"f58":"黄金9999","f60":836.08}}', '118.AU9999')).toMatchObject({ price: 840.01, prevClose: 836.08, time: null });
});

it('上海金间歇超时不丢弃伦敦金，回执说明缺失来源和不同单位', async () => {
  const tool = createMarketQuoteTool({ fetchImpl: async url => {
    if (url.includes('118.AU9999')) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return new Response(JSON.stringify({ data: { f43: 3909.95, f58: '伦敦金', f60: 3946.63 } }));
  } });
  const output = await tool.run({ target: '金价' });
  expect(output).toContain('3909.95 美元/盎司');
  expect(output).toContain('未取到：上海金：TimeoutError');
  expect(output).not.toContain('3909.95 元/克');
});

it('参考汇率实测约4.1秒可完成，同时用户取消仍立即终止', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn(async (url, { signal }) => {
      if (url.includes('eastmoney')) return new Response('{"data":null}');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 4134);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return new Response('{"result":"success","rates":{"CNY":6.67}}');
    });
    const tool = createMarketQuoteTool({ fetchImpl });
    const pending = tool.run({ target: 'USD' });
    await vi.advanceTimersByTimeAsync(4134);
    expect(await pending).toContain('每日参考价）：6.67 元');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const cancelled = expect(tool.run({ target: 'USD' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await cancelled;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});
