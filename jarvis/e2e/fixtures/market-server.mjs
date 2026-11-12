/** 隔离行情卡验收：真实 HTTP 上游、工具、任务、SSE、认证和存储；行情与模型均为本地虚构数据。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../../server/server.mjs';
import { createServerMode } from '../../server/serverMode.mjs';
import { createTaskRunner } from '../../server/taskRunner.mjs';
import { createMarketQuoteTool } from '../../src/agent/marketQuote.js';
import { createStockKlineTool } from '../../src/agent/stockKline.js';
import { DEFAULT_CONFIG } from '../../src/llm/config.js';

const data = process.env.JARVIS_DATA;
const counts = { modelCalls: 0, quoteCalls: 0, klineCalls: 0 };
const stats = () => {
  const target = path.join(data, 'fixture-stats.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(counts));
  fs.renameSync(target + '.tmp', target);
};
const bars = [
  ['2026-11-09', '1490', '1500', '1505', '1488', '101'],
  ['2026-11-10', '1500', '1496', '1508', '1492', '112'],
  ['2026-11-11', '1496', '1512', '1515', '1495', '123'],
];
const upstream = http.createServer((req, res) => {
  if (req.url === '/quote') {
    counts.quoteCalls++;
    const fields = Array(50).fill('');
    Object.assign(fields, { 1: '验收示例股份', 2: '600519', 3: '1500', 4: '1490', 5: '1490', 30: '20261111150000', 31: '10', 32: '0.67', 33: '1505', 34: '1488' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`v_sh600519="${fields.join('~')}";`);
  } else if (req.url === '/kline') {
    counts.klineCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { sh600519: { day: bars } } }));
  } else {
    res.writeHead(404);
    res.end();
  }
  stats();
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const actualFetch = globalThis.fetch;
// 禁止夹具误触真实公网；真实工具的上游 URL 仅映射到本机两个 HTTP 回执。
globalThis.fetch = (url, init) => {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw Error('行情夹具禁止外网请求');
  return actualFetch(url, init);
};
const quoteFetch = (url, init) => {
  const target = new URL(url);
  const route = target.hostname === 'qt.gtimg.cn' ? '/quote' : target.hostname === 'web.ifzq.gtimg.cn' ? '/kline' : null;
  if (!route) throw Error('夹具不支持此行情来源');
  return actualFetch(`http://127.0.0.1:${upstream.address().port}${route}`, init);
};
const runner = createTaskRunner({
  getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }),
  makeTools: ctx => {
    const context = { ...ctx, fetchViaGateway: quoteFetch, fetchImpl: quoteFetch };
    return [createMarketQuoteTool(context), createStockKlineTool(context)];
  },
  makeAdapter: () => ({ model: 'market-fixture', adapter: { stream: async ({ onText }) => {
    counts.modelCalls++;
    stats();
    // 模型只回复一句话，卡片不能来自这句文字或模型自报 JSON。
    const text = '已整理本次行情，来源与日期见报价卡。';
    onText?.(text);
    return { text, toolCalls: [], stop: 'end_turn' };
  } } }),
});
const mode = createServerMode({ dataDir: data, password: process.env.JARVIS_PASSWORD, runner });
const server = createServer({ serverMode: mode });
server.listen(Number(process.env.PORT), '127.0.0.1', () => { stats(); console.log('market-fixture-ready'); });
process.on('SIGTERM', () => { server.close(); upstream.close(); process.exit(0); });
