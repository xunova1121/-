/** 正式PC页面跨域发送聊天，保留浏览器CORS；模型与桌面桥仅用合成夹具，不调用外部服务。 */
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { runAsUser } from '../server/userScope.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-pc-cloud-chat');
await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'pc-cloud-chat-'));
const results = [], requests = [], browserRequests = [], responses = [], failed = [], errors = [], adapterCalls = [];
let rejections = [];
let holdReply = false, releaseReply = null;
const adapter = kind => cfg => ({
  model: cfg.models?.[cfg.provider] || 'fixture-chat',
  adapter: {
    async stream(input) {
      adapterCalls.push({ kind, model: input.model });
      const text = holdReply ? '正在处理合成断线用例。' : `你好，${kind === 'bridge' ? 'PC模型桥' : '云端任务'}合成回复已收到。`;
      input.onText?.(text);
      if (holdReply) await new Promise(resolve => { releaseReply = resolve; input.signal?.addEventListener('abort', resolve, { once: true }); });
      return { text, toolCalls: [], stop: 'end_turn' };
    }
  }
});
const mode = createServerMode({ dataDir: dir, password: 'fixture-pc-chat-password', makeTaskAdapter: adapter('task'), makeModelAdapter: adapter('bridge') });
await mode.ready;
const server = createServer({ serverMode: mode, ollama: null });
const desktop = createServer({ staticDir: path.resolve('dist'), ollama: null });
for (const app of [server, desktop]) await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const owner = createServerClient({ base, token: tokenFor('fixture-pc-chat-password') });
await owner.putConfig({ provider: 'custom', models: { custom: 'fixture-chat' }, keys: { custom: 'NOT_A_REAL_MODEL_KEY' }, baseURLs: { custom: 'https://fixture.invalid/v1' }, routing: { enabled: false } });
const member = await owner.createUser('PC跨域合成验收');
const login = await owner.loginAccount(member.accessCode);
const client = createServerClient({ base, token: login.token });
server.on('request', req => requests.push({ method: req.method, path: new URL(req.url, base).pathname }));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) throw new Error(name); };
try {
  await context.addInitScript(({ base, token, userId }) => {
    localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, userId, role: 'member', enabled: true }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false, autoMemory: false, teamMode: 'off' }));
    // 只令正式前端走安装版分支；不模拟原生电脑操作，也不声称Windows真机通过。
    window.jarvisDesktop = { platform: 'win32', onUpdate() {}, invoke: async () => ({ packaged: true, state: 'idle', version: 'fixture' }) };
    window.__pcChatRejections = [];
    addEventListener('unhandledrejection', e => window.__pcChatRejections.push(String(e.reason?.message || e.reason)));
  }, { base, token: login.token, userId: member.id });
  const page = await context.newPage();
  const network = await context.newCDPSession(page);
  await network.send('Network.enable');
  await network.send('Network.setBlockedURLs', { urls: ['https://*'] });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().startsWith(base)) browserRequests.push({ method: r.method(), path: new URL(r.url()).pathname }); });
  page.on('requestfailed', r => { if (r.url().startsWith(base)) failed.push({ method: r.method(), path: new URL(r.url()).pathname, error: r.failure()?.errorText }); });
  page.on('response', r => { if (r.url().startsWith(base)) responses.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() }); });
  await page.goto('http://127.0.0.1:' + desktop.address().port);
  await page.waitForFunction(() => window.__jarvisServerClient && window.__jarvis?.send);
  await page.evaluate(() => document.querySelector('#app-splash')?.remove());
  check('正式PC页面和云服务器使用不同源', await page.evaluate(() => location.origin !== new URL(window.__jarvisServerClient.base).origin));
  async function sendAndCheck(label, text, reply) {
    const before = requests.length;
    await page.fill('#prompt', text); await page.click('#btn-send');
    await page.waitForFunction(expected => !document.querySelector('#transcript .msg.agent.streaming') && [...document.querySelectorAll('#transcript .msg.agent .body')].some(n => n.textContent.includes(expected)), reply, { timeout: 20000 });
    const visible = await page.locator('#transcript').innerText();
    await page.screenshot({ path: `${out}/${label}.png` });
    check(`${label} 真实点击发送后收到完整回复`, visible.includes(reply) && !/Failed to fetch|连接失败|出错了/.test(visible));
    return requests.slice(before);
  }
  await page.locator('.rail .wb-new').click();
  const ordinary = await sendAndCheck('ordinary', '你好', '云端任务合成回复已收到');
  check('普通聊天提交任务并读取事件流', ordinary.some(r => r.method === 'POST' && r.path === '/api/tasks') && ordinary.some(r => r.method === 'GET' && /\/api\/tasks\/[^/]+\/events$/.test(r.path)));
  check('普通聊天保存在本人服务器会话', (await client.listSessions()).some(s => s.count === 2));
  await page.locator('.rail [data-destination="agents"]').click();
  await page.locator('.wy-agent-card[data-agent="health-advisor"]').click();
  await page.waitForSelector('.wy-agent-start[data-agent="health-advisor"]');
  const agent = await sendAndCheck('health-agent', '你好', '云端任务合成回复已收到');
  check('内置智能体也经远端任务完成', agent.some(r => r.method === 'POST' && r.path === '/api/tasks') && await page.evaluate(async () => (await window.__jarvis.sessionGet(window.__jarvis.sessionId)).agentId === 'health-advisor'));
  await page.locator('.rail .wb-new').click();
  const bridge = await sendAndCheck('pc-bridge', '查看我电脑桌面的文件', 'PC模型桥合成回复已收到');
  check('电脑任务使用模型桥，不错误提交云端执行任务', bridge.some(r => r.method === 'POST' && r.path === '/api/server/pc-model') && !bridge.some(r => r.method === 'POST' && r.path === '/api/tasks'));
  check('实际浏览器对任务和模型桥发送OPTIONS预检', ['/api/tasks', '/api/server/pc-model'].every(p => requests.some(r => r.method === 'OPTIONS' && r.path === p)));
  // 流读到最终结果后客户端主动cancel reader，Chromium记ERR_ABORTED；前面已核验回复完整。
  const broken = failed.filter(r => !(r.error === 'net::ERR_ABORTED' && (r.path.endsWith('/events') || r.path === '/api/server/pc-model')));
  rejections = await page.evaluate(() => window.__pcChatRejections);
  check('三类正常请求没有连接失败或脚本异常', broken.length === 0 && errors.length === 0 && rejections.length === 0);
  if (process.env.WEIYANG_CHAT_OUTAGE === '1') {
    await page.locator('.rail .wb-new').click(); holdReply = true;
    await page.fill('#prompt', '你好'); await page.click('#btn-send');
    await page.waitForFunction(() => document.querySelector('#transcript')?.textContent.includes('正在处理合成断线用例'));
    const submitted = browserRequests.filter(r => r.method === 'POST' && r.path === '/api/tasks').length;
    const disconnectedAt = Date.now();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // PC回答末尾使用CSS ::after显示状态；核验实际生成内容和可见样式，而非只看data属性。
    await page.waitForFunction(() => {
      const n = document.querySelector('#transcript .msg.agent.streaming');
      if (!n) return false;
      const s = getComputedStyle(n, '::after'), r = n.getBoundingClientRect();
      return s.content.includes('回答连接中断，正在重连原任务') && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }, null, { timeout: 10000 });
    const reconnecting = await page.locator('#transcript .msg.agent.streaming').evaluate(n => ({ content: getComputedStyle(n, '::after').content, display: getComputedStyle(n, '::after').display, visibility: getComputedStyle(n, '::after').visibility }));
    await writeFile(`${out}/reconnecting.json`, JSON.stringify(reconnecting, null, 2));
    await page.screenshot({ path: `${out}/reconnecting.png` });
    check('断线重连提示真实显示在PC回答末尾', reconnecting.content.includes('回答连接中断，正在重连原任务') && reconnecting.display !== 'none' && reconnecting.visibility === 'visible');
    await page.waitForFunction(() => !document.querySelector('.msg.agent.streaming') && document.querySelector('#transcript')?.textContent.includes('已暂停自动重连'), null, { timeout: 30000 });
    const outage = await page.evaluate(() => ({ streaming: Boolean(document.querySelector('.msg.agent.streaming')), transcript: document.querySelector('#transcript').innerText, rejections: window.__pcChatRejections }));
    outage.elapsedMs = Date.now() - disconnectedAt;
    await writeFile(`${out}/outage.json`, JSON.stringify(outage, null, 2));
    await page.screenshot({ path: `${out}/outage.png` });
    check('持续断线在有限时间内停止转圈', !outage.streaming && outage.elapsedMs < 40000);
    check('保留半句并说明原任务可能仍执行、不要重复提交', outage.transcript.includes('正在处理合成断线用例') && outage.transcript.includes('服务器可能仍在执行') && outage.transcript.includes('避免重复发送'));
    check('断线不会重新提交或停止原任务', browserRequests.filter(r => r.method === 'POST' && r.path === '/api/tasks').length === submitted && !browserRequests.some(r => r.method === 'POST' && r.path.endsWith('/stop')) && runAsUser(member.id, () => mode.runner.list().some(t => t.status === 'running')));
    const actions = await page.locator('.callout:visible .cl-title, .chip-bar .chip:visible').allTextContents();
    check('断线建议仅提供原对话和连接设置，不提供重发', actions.length === 2 && actions.includes('查看原对话') && actions.includes('检查服务器连接'));
    check('断线处理没有脚本异常或未捕获错误', errors.length === 0 && outage.rejections.length === 0);
    holdReply = false; releaseReply?.();
  } else if (process.env.WEIYANG_CHAT_OUTAGE === 'submit') {
    await page.locator('.rail .wb-new').click();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await page.fill('#prompt', '你好'); await page.click('#btn-send');
    await page.waitForFunction(() => !document.querySelector('.msg.agent.streaming') && document.querySelector('#transcript')?.textContent.includes('出错了'), null, { timeout: 30000 });
    const outage = await page.evaluate(() => ({ streaming: Boolean(document.querySelector('.msg.agent.streaming')), transcript: document.querySelector('#transcript').innerText, rejections: window.__pcChatRejections }));
    await writeFile(`${out}/submit-outage.json`, JSON.stringify(outage, null, 2));
    await page.screenshot({ path: `${out}/submit-outage.png` });
    check('发送前离线显示提交任务阶段与连接检查指引', !outage.streaming && outage.transcript.includes('提交任务失败') && outage.transcript.includes('未收到可读取的服务器响应') && outage.transcript.includes('服务器模式'));
    check('提交无响应明确接收状态未知，提醒先查看原对话', outage.transcript.includes('暂时无法确认任务是否已被接收') && outage.transcript.includes('再打开原对话查看') && outage.transcript.includes('避免重复发送'));
    const actions = await page.locator('.callout:visible, .chip-bar .chip:visible').evaluateAll(nodes => nodes.map(n => ({ label: n.querySelector('.cl-title')?.textContent || n.textContent, title: n.title })));
    check('提交状态未知仅提供两项查看入口，无重发或模型设置建议', actions.length === 2 && actions.every(a => a.title.startsWith('打开：')) && actions.some(a => a.label === '查看原对话') && actions.some(a => a.label === '检查服务器连接') && actions.every(a => !/再试一次|检查模型设置/.test(a.label)));
    check('发送前离线不误报模型Key或服务商权限', !/API Key|密钥|401|服务商|启动.bat/.test(outage.transcript));
    check('发送前离线没有脚本异常或未捕获错误', errors.length === 0 && outage.rejections.length === 0);
  }
} finally {
  holdReply = false; releaseReply?.();
  await browser.close(); await mode.tenders.stop(); await mode.runner.settled();
  for (const app of [server, desktop]) { app.closeAllConnections(); if (app.listening) await new Promise(resolve => app.close(resolve)); }
  useBackend(null); await rm(dir, { recursive: true, force: true });
  await writeFile(`${out}/results.json`, JSON.stringify({ results, requests, browserRequests, responses, failed, errors, rejections, adapterCalls }, null, 2));
}
console.log(`PC云端聊天 ${results.length}/${results.length} 通过（合成模型、桌面桥替身，非真机验收）`);
