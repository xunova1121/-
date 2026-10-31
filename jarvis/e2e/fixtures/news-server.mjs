/** 实际网关/任务/工具；新闻HTML和公开JSON上游用虚构内容，外网完全禁止。 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createServer } from '../../server/server.mjs';
import { createServerMode } from '../../server/serverMode.mjs';
import { createTaskRunner } from '../../server/taskRunner.mjs';
import { DEFAULT_CONFIG } from '../../src/llm/config.js';
import { createLookupService, memoryLookupStorage } from '../../src/agent/lookup/service.js';
const data = process.env.JARVIS_DATA;
const domestic = process.env.LOOKUP_CN_FIXTURE === '1';
let upstream = 0, models = 0;
const stats = () => fs.writeFileSync(path.join(data, 'news-stats.json'), JSON.stringify({ upstream, models }));
const hosts = ['www.cnfin.com', 'news.cnr.cn', 'www.chinanews.com.cn', 'news.zhibo8.com', 'feed.mix.sina.com.cn', 'feeds.bbci.co.uk', 'www.channelnewsasia.com', 'www.theguardian.com', 'www.aljazeera.com', 'data.example.com', 'private.example.com'];
const originalLookup = dns.lookup.bind(dns);
dns.lookup = (host, options) => hosts.includes(host) ? Promise.resolve([{ address: host === 'private.example.com' ? '127.0.0.1' : '93.184.216.34', family: 4 }]) : originalLookup(host, options);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (address, init) => {
  const url = new URL(address);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return originalFetch(address, init);
  if (!hosts.includes(url.hostname)) throw TypeError('隔离测试不访问外部网络');
  upstream++; stats();
  if (url.hostname === 'data.example.com') return url.pathname === '/redirect' ? new Response('', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }) : Response.json({ count: 18, unit: '条', date: '2026-10-30' });
  const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  if (domestic && ['feeds.bbci.co.uk', 'www.channelnewsasia.com', 'www.theguardian.com', 'www.aljazeera.com'].includes(url.hostname)) return new Response('', { status: 403 });
  if (domestic && url.hostname === 'www.chinanews.com.cn') {
    return new Response(['体育', '国际', '国内', '财经', '科技'].flatMap(category => Array.from({ length: 6 }, (_, i) => `<li><div class="dd_lm">[${category}]</div><div class="dd_bt"><a href="https://www.chinanews.com.cn/ty/${today.slice(0, 4)}/${today.slice(5)}/${category}${i}.shtml">虚构${category}报道：公共训练设施与便民服务第${i}项</a></div><div class="dd_time">${today.slice(5)} 00:00</div></li>`)).join(''));
  }
  if (url.hostname === 'news.zhibo8.com') return url.pathname === '/zuqiu/' ? new Response(Array.from({ length: 5 }, (_, i) => `<a href="https://news.zhibo8.com/zuqiu/${today}/fixture${i}.htm">虚构体育报道：训练设施开放预约${i}</a>`).join('')) : new Response(`<h1>虚构体育报道：训练设施开放预约</h1><span ms-controller="title_controller">${today} 00:00:00</span><div id="signals"><p>新增三项便民服务和训练设施，不是比分卡。</p></div>`);
  if (url.hostname === 'feed.mix.sina.com.cn') return Response.json({ result: { status: { code: 0 }, data: [] } });
  if (url.hostname === 'www.channelnewsasia.com' && /^\/(?:world|sport)\/fixture-/.test(url.pathname)) {
    const id = url.pathname.at(-1);
    return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', mainEntityOfPage: url.href, datePublished: today + 'T00:00:00+08:00' })}</script><div class="source source--with-label">Source: ${id === '3' ? 'Reuters' : 'AFP'}/fs</div>`);
  }
  if (['feeds.bbci.co.uk', 'www.channelnewsasia.com', 'www.theguardian.com', 'www.aljazeera.com'].includes(url.hostname)) {
    const file = url.hostname === 'www.channelnewsasia.com' ? 'reuters-cna.xml' : 'bbc.xml';
    let xml = fs.readFileSync('tests/fixtures/news/' + file, 'utf8').replaceAll('Fri, 30 Oct 2026 01:00:00 GMT', new Date(today + 'T00:00:00+08:00').toUTCString());
    if (url.pathname.includes('/sport/') || url.searchParams.get('category') === '10296') xml = xml.replaceAll('虚构国际报道', '虚构体育报道').replaceAll('/world/fixture-', '/sport/fixture-');
    return new Response(xml.replaceAll('www.bbc.com', url.hostname === 'www.theguardian.com' ? 'www.theguardian.com' : url.hostname === 'www.aljazeera.com' ? 'www.aljazeera.com' : 'www.bbc.com'), { headers: { 'Content-Type': 'application/rss+xml' } });
  }
  const id = { 'www.cnfin.com': 'cnfin', 'news.cnr.cn': 'cnr', 'www.chinanews.com.cn': 'cns' }[url.hostname];
  if (!id) throw Error('私网不应发出请求');
  const yesterday = new Date(Date.now() - 86400000 + 28800000).toISOString().slice(0, 10);
  const html = fs.readFileSync('tests/fixtures/news/' + id + '.html', 'utf8').replaceAll('2026-10-29', yesterday).replaceAll('20261029', yesterday.replaceAll('-', '')).replaceAll('2026-10-30', today).replaceAll('20261030', today.replaceAll('-', '')).replaceAll('2026/10-30', today.replaceAll('-', '/').replace(/\/(\d{2})$/, '-$1')).replaceAll('10-30 ', today.slice(5) + ' ');
  // 虚构条目统一当日零点发布，避免清晨/跨天打包时测试数据落到未来；生产日期校验不放宽。
  const timed = html.replace(/\b(?:09:15:00|08:20|09:30|10:30)\b/g, '00:00');
  return new Response(timed, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};
const configFile = path.join(data, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, provider: 'mock', lookupRegion: domestic ? 'cn' : 'global' }));
const lookupService = createLookupService({ storage: memoryLookupStorage(), get: (url, init) => globalThis.fetch(url, init) });
const runner = createTaskRunner({ lookupService, getConfig: async () => JSON.parse(fs.readFileSync(configFile, 'utf8')), makeAdapter: () => ({ model: 'fixture', adapter: { kind: 'fixture', stream: async ({ messages, onText }) => {
  models++; stats();
  const text = /那么慢|在干嘛/.test(messages.at(-1)?.content || '') ? '没有重新联网，我先说明当前进度。' : '';
  if (text) onText?.(text);
  return { text, toolCalls: [], stop: 'end_turn' };
} } }) });
const mode = createServerMode({ dataDir: data, password: process.env.JARVIS_PASSWORD, runner, lookupService });
const server = createServer({ serverMode: mode });
server.listen(Number(process.env.PORT), '127.0.0.1', () => { stats(); console.log('news-fixture-ready'); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
