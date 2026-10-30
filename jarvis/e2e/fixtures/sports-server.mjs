/** 隔离浏览器验收：真实服务器/任务/认证/持久化，仅模型和比分上游用虚构回执。 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createServer } from '../../server/server.mjs';
import { createServerMode } from '../../server/serverMode.mjs';
import { createTaskRunner } from '../../server/taskRunner.mjs';
import { DEFAULT_CONFIG } from '../../src/llm/config.js';
const data = process.env.JARVIS_DATA;
let modelCalls = 0, upstreamCalls = 0, scoreRevision = 0;
const stats = () => fs.writeFileSync(path.join(data, 'fixture-stats.json'), JSON.stringify({ modelCalls, upstreamCalls, scoreRevision }));
const actualLookup = dns.lookup.bind(dns);
dns.lookup = (host, opts) => ['bifen4pc.qiumibao.com', 'site.api.espn.com'].includes(host) ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : actualLookup(host, opts);
const actualFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const host = new URL(url).hostname;
  if (!['bifen4pc.qiumibao.com', 'site.api.espn.com'].includes(host)) {
    if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return actualFetch(url, init);
    throw TypeError('隔离测试不访问外部网络');
  }
  upstreamCalls++; stats();
  if (fs.existsSync(path.join(data, 'fail-all'))) throw TypeError('fixture offline');
  const now = Date.now();
  if (host === 'site.api.espn.com') return Response.json({ events: [] });
  // 只有比分源刷新才更新模拟比分，不能用含ESPN补充请求的总次数取模：
  // 跨午夜会增加补充请求，取模后新旧比分可能相等，误报刷新未执行。
  scoreRevision++; stats();
  const match = (id, delta, state, period) => {
    const beijing = new Date(now + delta * 60000 + 28800000).toISOString();
    return { id, type: 'football', leagueid: 'synthetic', sdate: beijing.slice(0, 10), time: beijing.slice(11, 16), state, period_cn: period, home_team: id === 'live' ? '江城星光' : '云港竞技', visit_team: id === 'live' ? '海湾联队' : '山川青年', home_score: String(scoreRevision), visit_score: '0' };
  };
  // 日期覆盖锚点只用于证明原列表包含前后日；本窗口必须把这些远处场次滤掉。
  return Response.json({ list: [match('next', 30, '1', ''), match('live', -60, '2', '中场'), match('finished', -90, '3', '完场'), match('anchor-before', -1500, '3', '完场'), match('anchor-after', 1500, '1', '')] });
};
const runner = createTaskRunner({
  getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }),
  makeAdapter: () => ({ model: 'fixture', adapter: { stream: async ({ onText }) => { modelCalls++; stats(); const text = '已整理当前附近的足球赛程，进行中的比赛排在前面。'; onText?.(text); return { text, toolCalls: [], stop: 'end_turn' }; } } })
});
const mode = createServerMode({ dataDir: data, password: process.env.JARVIS_PASSWORD, runner });
const server = createServer({ serverMode: mode });
server.listen(Number(process.env.PORT), '127.0.0.1', () => { stats(); console.log('sports-fixture-ready'); });
const local = createServer();
local.listen(0, '127.0.0.1', () => console.log('sports-local-ready:' + local.address().port));
process.on('SIGTERM', () => { server.close(); local.close(); process.exit(0); });
