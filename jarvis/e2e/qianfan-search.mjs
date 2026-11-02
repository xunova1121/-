/** 浏览器设置→真实鉴权路由→固定官方地址拦截→本地HTTP替身；不请求公网付费接口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { newsDate } from '../src/agent/newsSources.js';
import { QIANFAN_ENDPOINT } from '../src/agent/qianfanSearch.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-qianfan-search');
await fs.mkdir(out, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-qianfan-e2e-'));
const key = 'FAKE_QIANFAN_BROWSER_FIXTURE_ONLY';
let state = 'ok', requests = 0, lastBody;
const upstream = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  lastBody = JSON.parse(Buffer.concat(parts));
  requests++;
  assert.equal(req.headers.authorization, 'Bearer ' + key);
  res.setHeader('Content-Type', 'application/json');
  if (state === 'unauthorized') { res.writeHead(401); res.end('raw upstream ' + key); return; }
  if (state === 'quota') { res.writeHead(429); res.end('raw upstream ' + key); return; }
  res.end(JSON.stringify({ references: [1, 2, 3].map(index => ({ id: index, type: 'web', title: `合成当日标题${index}`, url: `https://www.chinanews.com.cn/fixture-${index}.html`, content: '这只是浏览器合成测试摘要。', date: newsDate(Date.now()) + ' 00:00:00' })) }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (String(url).startsWith('https://qianfan.baidubce.com/')) {
    assert.equal(String(url), QIANFAN_ENDPOINT);
    return originalFetch(upstreamURL, options);
  }
  return originalFetch(url, options);
};
const localServer = createServer({ staticDir: path.resolve('dist'), ollama: null });
await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
const localBase = `http://127.0.0.1:${localServer.address().port}`;
const mode = createServerMode({ dataDir, password: 'qianfan-browser-fixture', searchFetch: (url, options) => {
  assert.equal(url, QIANFAN_ENDPOINT);
  if (state === 'offline') throw Object.assign(new Error('fake offline'), { kind: 'network' });
  return fetch(upstreamURL, options);
} });
await mode.ready;
const server = createServer({ serverMode: mode, staticDir: path.resolve('dist'), ollama: null });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'qianfan-browser-fixture' }) });
const { token } = await login.json();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('✓ ' + label); };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ base, token }) => localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true })), { base, token });
  const page = await context.newPage(), errors = [], logs = [];
  page.on('pageerror', failure => errors.push(failure.message));
  page.on('console', message => logs.push(message.text()));
  await page.goto(base);
  await page.waitForFunction(() => globalThis.__jarvisServerMode === true);
  await page.evaluate(() => globalThis.__jarvis.showPanel('models'));
  await page.getByRole('button', { name: '服务商', exact: true }).click();
  const pane = page.locator('.ml-service-keys');
  await pane.locator('summary').click();
  await pane.getByLabel('百度千帆搜索 Key', { exact: true }).fill(key);
  await pane.getByRole('button', { name: '测试百度搜索', exact: true }).click();
  check(requests === 0 && (await pane.innerText()).includes('请先保存'), '未保存的新Key不拿旧配置测试');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/server/config') && response.request().method() === 'PUT');
  await pane.getByRole('button', { name: '保存到云服务器', exact: true }).click();
  assert.equal((await saved).status(), 200);
  if (!(await pane.evaluate(element => element.open))) await pane.locator('summary').click();
  await pane.getByRole('button', { name: '测试百度搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ml-service-keys')?.innerText.includes('合成当日标题3'));
  check((await pane.innerText()).includes('3条') && (await pane.innerText()).includes('chinanews.com.cn'), '设置页显示真实替身的条数、前三条标题、日期和域名');
  check(lastBody.resource_type_filter[0].top_k === 10 && lastBody.search_filter.range.page_time.gte === newsDate(Date.now()), '实际请求使用网页10条及北京时间当天范围');
  check((await pane.getByLabel('百度千帆搜索 Key', { exact: true }).inputValue()) === '', '保存后新Key输入框清空，可直接测试保存值');
  await page.screenshot({ path: path.join(out, 'qianfan-settings.png'), fullPage: false });
  for (const [next, expected] of [['unauthorized', 'Key无效'], ['quota', '额度不足或服务商限流'], ['offline', '网络连接失败']]) {
    state = next;
    await pane.getByRole('button', { name: '测试百度搜索', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('.ml-service-keys')?.innerText.includes(expected), expected);
    check(true, next + '显示受控原因，未用旧结果假装成功');
  }
  const configuration = await fetch(base + '/api/server/config', { headers: { Authorization: 'Bearer ' + token } });
  check(configuration.status === 200 && !(await configuration.text()).includes(key), '服务商401不误退出未央登录，配置返回Key掩码');
  check(!logs.join('\n').includes(key) && !(await page.evaluate(() => JSON.stringify(localStorage))).includes(key), 'Key不进入浏览器持久化或控制台');
  check(errors.length === 0, '搜索设置无页面异常');
  await context.close();
  state = 'ok';
  const localContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await localContext.addInitScript(key => localStorage.setItem('jarvis.llm.v1', JSON.stringify({ qianfanSearchKey: key })), key);
  const localPage = await localContext.newPage(), localErrors = [], localRequests = [];
  localPage.on('pageerror', error => localErrors.push(error.message));
  localPage.on('request', request => { if (request.url().includes('/api/llm/qianfan/')) localRequests.push(request); });
  await localPage.route('**/api/fetch?**', route => route.fulfill({ status: 405, body: '不能用普通网页读取代替搜索POST' }));
  await localPage.route(QIANFAN_ENDPOINT, route => route.fulfill({ status: 403, body: '测试不得请求公网，必须走本机网关' }));
  await localPage.goto(localBase);
  await localPage.waitForFunction(() => globalThis.__jarvis?.gateway?.origin);
  await localPage.evaluate(() => globalThis.__jarvis.showPanel('models'));
  await localPage.getByRole('button', { name: '服务商', exact: true }).click();
  const localPane = localPage.locator('.ml-service-keys');
  await localPane.locator('summary').click();
  const beforeLocal = requests;
  await localPane.getByRole('button', { name: '测试百度搜索', exact: true }).click();
  await localPage.waitForFunction(() => [...document.querySelectorAll('.ml-service-keys button')].some(button => button.textContent === '测试百度搜索' && !button.disabled));
  check(localRequests.length === 1 && localRequests[0].method() === 'POST' && localRequests[0].url() === localBase + '/api/llm/qianfan/v2/ai_search/web_search', '本机经专用千帆POST路由，不走普通网页读取');
  check(requests === beforeLocal + 1 && (await localPane.innerText()).includes('合成当日标题3') && lastBody.resource_type_filter[0].top_k === 10, '本机网关实际转发正文与授权，收到固定HTTP替身结果');
  check(localErrors.length === 0, '本机千帆设置无页面异常');
  await localContext.close();
  console.log(`${checks}/${checks} 通过；固定本地HTTP替身，不是国内网络或用户Key实测。`);
} finally {
  await browser.close();
  globalThis.fetch = originalFetch;
  await new Promise(resolve => localServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  useBackend(null);
  await fs.rm(dataDir, { recursive: true, force: true });
}
