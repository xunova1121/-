/** 正式mobile构建+实际HTTP/SSE：模拟原生前台事件；不代表Android真机、VPN或用户443网络验收。 */
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';

const out = process.argv[2] || '/tmp/weiyang-server-resume';
await mkdir(out, { recursive: true });
const data = await mkdtemp(path.join(os.tmpdir(), 'weiyang-resume-'));
let finishModel, eventStream;
const requests = [], checks = [], errors = [], pendingConfig = [];
const check = (label, ok) => { checks.push({ label, ok: Boolean(ok) }); console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) throw Error(label); };
const makeTaskAdapter = () => ({ model: 'resume-fixture-chat', adapter: { async stream(input) {
  input.onText?.('恢复前已有内容。');
  await new Promise(resolve => { finishModel = resolve; input.signal?.addEventListener('abort', resolve, { once: true }); });
  input.onText?.('恢复后收到结果。');
  return { text: '恢复前已有内容。恢复后收到结果。', toolCalls: [], stop: 'end_turn' };
} } });
const mode = createServerMode({ dataDir: data, password: 'fixture-resume-password', makeTaskAdapter });
await mode.ready;
const server = createServer({ serverMode: mode, ollama: null });
const mobile = createServer({ staticDir: path.resolve('dist-mobile'), ollama: null });
for (const service of [server, mobile]) await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
server.on('request', (req, res) => {
  const url = new URL(req.url, base);
  if (req.method === 'GET' && url.pathname.endsWith('/events')) eventStream = res;
  requests.push({ path: url.pathname, method: req.method, after: Number(url.searchParams.get('after') || 0), at: Date.now() });
});
const owner = createServerClient({ base, token: tokenFor('fixture-resume-password') });
await owner.putConfig({ provider: 'custom', models: { custom: 'resume-fixture-chat' }, keys: { custom: 'FIXTURE_MODEL_SECRET' }, baseURLs: { custom: 'https://fixture.invalid/v1' }, pinModel: true });
const member = await owner.createUser('恢复测试甲'), other = await owner.createUser('恢复测试乙');
const login = await owner.loginAccount(member.accessCode), otherLogin = await owner.loginAccount(other.accessCode);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
let resumeMs = null, cachedMs = null;
try {
  await context.route('https://**/*', route => route.abort());
  await context.addInitScript(({ base, token, userId }) => {
    if (!localStorage.getItem('jarvis.server.v1')) localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, userId, role: 'member', enabled: true }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false, autoMemory: false, theme: 'day', teamMode: 'off' }));
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    window.__resumeRejections = [];
    addEventListener('unhandledrejection', e => window.__resumeRejections.push(String(e.reason?.message || e.reason)));
  }, { base, token: login.token, userId: member.id });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${mobile.address().port}`);
  await page.waitForFunction(() => window.__jarvisServerClient && window.__jarvis);
  await page.evaluate(() => document.querySelector('#app-splash')?.remove());
  await page.waitForFunction(() => localStorage.getItem('jarvis.server.model-preview.v1'));
  await page.click('#prompt'); await page.click('#model-chip'); await page.waitForSelector('.ml-picker-results .ml-picker-model');
  check('联网成功后模型选择器显示服务器型号', (await page.locator('.ml-picker').innerText()).includes('resume-fixture-chat'));
  await page.click('.ml-dismiss');
  const preview = await page.evaluate(() => localStorage.getItem('jarvis.server.model-preview.v1'));
  check('持久化预览不含模型Key、访问Token或上游URL', !preview.includes('FIXTURE_MODEL_SECRET') && !preview.includes(login.token) && !preview.includes('fixture.invalid'));

  await page.fill('#prompt', '你好'); await page.click('#btn-send');
  await page.waitForFunction(() => document.querySelector('#transcript')?.textContent.includes('恢复前已有内容。'));
  const before = requests.filter(r => r.method === 'GET' && r.path.endsWith('/events')).length;
  const resumeAt = Date.now();
  await page.evaluate(() => {
    window.__jarvisForeground = false;
    dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: false } }));
    window.__jarvisForeground = true;
    dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: true } }));
    dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(() => window.__jarvisServerClient.timings.some(r => r.path.endsWith('/events') && r.ok));
  for (let n = 0; n < 100 && requests.filter(r => r.method === 'GET' && r.path.endsWith('/events')).length === before; n++) await new Promise(resolve => setTimeout(resolve, 25));
  const resumed = requests.filter(r => r.method === 'GET' && r.path.endsWith('/events'));
  resumeMs = resumed.at(-1).at - resumeAt;
  check('前台立即续接同一任务，不等10秒轮询或45秒失活', resumed.length === before + 1 && resumed.at(-1).after > 0 && resumeMs < 2500);
  check('前台/焦点双事件只续接一次，任务没有重复提交', requests.filter(r => r.path === '/api/tasks' && r.method === 'POST').length === 1);
  // 切回前台后，真实 SSE 只收到心跳便结束。旧内核也应走重试，按上次序号继续读。
  const lastResume = resumed.at(-1);
  eventStream.end(': heartbeat\n\n');
  const retryUntil = Date.now() + 10000;
  const sameTaskReads = () => requests.filter(r => r.method === 'GET' && r.path === lastResume.path);
  while (sameTaskReads().length <= resumed.length && Date.now() < retryUntil) await new Promise(resolve => setTimeout(resolve, 25));
  check('旧WebView缺少AbortSignal.any时，首次续接中断后仍按原任务序号重试',
    sameTaskReads().length === resumed.length + 1 && sameTaskReads().at(-1).after >= lastResume.after);
  finishModel();
  await page.waitForFunction(() => !document.querySelector('#transcript .msg.agent.streaming') && document.querySelector('#transcript')?.textContent.includes('恢复后收到结果。'));
  check('结果完整续回且旧段落不重复', (await page.locator('#transcript').innerText()).split('恢复前已有内容。').length === 2);
  check('恢复并完成时只提交一次任务，也没有发出停止请求', requests.filter(r => r.path === '/api/tasks' && r.method === 'POST').length === 1 &&
    !requests.some(r => r.method === 'POST' && r.path === lastResume.path.replace(/events$/, 'stop')));
  await page.screenshot({ path: path.join(out, 'resumed-task.png') });

  await context.route(base + '/api/server/config', route => new Promise(resolve => pendingConfig.push(async () => { await route.abort(); resolve(); })));
  await page.reload(); await page.waitForFunction(() => window.__jarvisServerClient && window.__jarvis);
  await page.evaluate(() => document.querySelector('#app-splash')?.remove());
  const cachedAt = Date.now(); await page.click('#prompt'); await page.click('#model-chip');
  await page.waitForSelector('.ml-picker-results .ml-picker-model'); cachedMs = Date.now() - cachedAt;
  check('进程重建后服务器配置仍挂起，缓存型号已可见', pendingConfig.length > 0 && (await page.locator('.ml-picker').innerText()).includes('resume-fixture-chat'));
  check('界面说明仍在同步，没有把缓存当作服务器已连接', (await page.locator('.ml-picker').innerText()).includes('正在同步最新配置'));
  await page.screenshot({ path: path.join(out, 'cached-models.png') }); await page.click('.ml-dismiss');
  await page.evaluate(({ token, userId }) => { const cfg = JSON.parse(localStorage.getItem('jarvis.server.v1')); localStorage.setItem('jarvis.server.v1', JSON.stringify({ ...cfg, token, userId })); }, { token: otherLogin.token, userId: other.id });
  await page.reload(); await page.waitForFunction(() => window.__jarvisServerClient && window.__jarvis);
  await page.evaluate(() => document.querySelector('#app-splash')?.remove()); await page.click('#prompt'); await page.click('#model-chip');
  check('切换账号后即使服务器配置挂起，也不显示上个账号的缓存型号', !(await page.locator('.ml-picker').innerText()).includes('resume-fixture-chat'));
  check('浏览器没有脚本错误或未处理拒绝', errors.length === 0 && (await page.evaluate(() => window.__resumeRejections)).length === 0);
} finally {
  finishModel?.();
  await Promise.allSettled(pendingConfig.map(close => close()));
  await context.close(); await browser.close(); await mode.tenders.stop(); await mode.runner.settled();
  for (const service of [server, mobile]) { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ realAndroid: false, realUserServer: false, syntheticHTTP: true, resumeMs, cachedMs, checks, errors }, null, 2));
  useBackend(null); await rm(data, { recursive: true, force: true });
}
console.log(`前台恢复 ${checks.filter(c => c.ok).length}/${checks.length} 通过`);
