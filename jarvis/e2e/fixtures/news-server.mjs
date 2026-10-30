/** 实际网关/任务/工具；新闻HTML和公开JSON上游用虚构内容，外网完全禁止。 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createServer } from '../../server/server.mjs';
import { createServerMode } from '../../server/serverMode.mjs';
import { createTaskRunner } from '../../server/taskRunner.mjs';
import { DEFAULT_CONFIG } from '../../src/llm/config.js';
const data = process.env.JARVIS_DATA;
let upstream = 0, models = 0;
const stats = () => fs.writeFileSync(path.join(data, 'news-stats.json'), JSON.stringify({ upstream, models }));
const hosts = ['www.cnfin.com', 'news.cnr.cn', 'www.chinanews.com.cn', 'data.example.com', 'private.example.com'];
const originalLookup = dns.lookup.bind(dns);
dns.lookup = (host, options) => hosts.includes(host) ? Promise.resolve([{ address: host === 'private.example.com' ? '127.0.0.1' : '93.184.216.34', family: 4 }]) : originalLookup(host, options);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (address, init) => {
  const url = new URL(address);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return originalFetch(address, init);
  if (!hosts.includes(url.hostname)) throw TypeError('隔离测试不访问外部网络');
  upstream++; stats();
  if (url.hostname === 'data.example.com') return url.pathname === '/redirect' ? new Response('', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }) : Response.json({ count: 18, unit: '条', date: '2026-10-30' });
  const id = { 'www.cnfin.com': 'cnfin', 'news.cnr.cn': 'cnr', 'www.chinanews.com.cn': 'cns' }[url.hostname];
  if (!id) throw Error('私网不应发出请求');
  const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000 + 28800000).toISOString().slice(0, 10);
  const html = fs.readFileSync('tests/fixtures/news/' + id + '.html', 'utf8').replaceAll('2026-10-29', yesterday).replaceAll('20261029', yesterday.replaceAll('-', '')).replaceAll('2026-10-30', today).replaceAll('20261030', today.replaceAll('-', '')).replaceAll('2026/10-30', today.replaceAll('-', '/').replace(/\/(\d{2})$/, '-$1')).replaceAll('10-30 ', today.slice(5) + ' ');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};
const runner = createTaskRunner({ getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }), makeAdapter: () => ({ model: 'fixture', adapter: { kind: 'fixture', stream: async ({ messages, onText }) => {
  models++; stats();
  const text = /那么慢|在干嘛/.test(messages.at(-1)?.content || '') ? '没有重新联网，我先说明当前进度。' : '';
  if (text) onText?.(text);
  return { text, toolCalls: [], stop: 'end_turn' };
} } }) });
const mode = createServerMode({ dataDir: data, password: process.env.JARVIS_PASSWORD, runner });
const server = createServer({ serverMode: mode });
server.listen(Number(process.env.PORT), '127.0.0.1', () => { stats(); console.log('news-fixture-ready'); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
