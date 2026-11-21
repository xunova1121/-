/** 真实HTTP、会话落盘和浏览器；模型为固定替身，不测真实服务商速度/费用。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

const output = process.argv[2] || '/tmp/weiyang-task-cost-e2e';
await fs.mkdir(output, { recursive: true });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-task-cost-'));
const pass = 'fixture-password';
await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ provider: 'openai', models: { openai: 'fixture-light' }, keys: { openai: 'fixture-not-a-key' }, abilities: { code: { main: { provider: 'openai', model: 'fixture-code' } } }, autoMemory: false, hedgeBackup: false }));
const calls = [];
const mode = createServerMode({ dataDir: dir, password: pass, makeTaskAdapter: cfg => ({ model: cfg.models[cfg.provider], adapter: { kind: 'mock', async stream(input) {
  calls.push({ model: input.model, toolCount: input.tools.length, inputChars: JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools }).length, hasOriginal: JSON.stringify(input).includes('鹈鹕') });
  const text = input.model === 'fixture-code' ? '当前是编程任务；这次只核对任务状态，尚未创建或验证文件。' : '你好，我在。';
  input.onText?.(text);
  return { text, toolCalls: [], stop: 'end_turn' };
} } }) });
await mode.ready;
const http = createServer({ serverMode: mode, ollama: null });
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${http.address().port}`;
const mobileHttp = createServer({ serverMode: mode, staticDir: path.resolve('dist-mobile'), ollama: null });
await new Promise(resolve => mobileHttp.listen(0, '127.0.0.1', resolve));
const mobileBase = `http://127.0.0.1:${mobileHttp.address().port}`;
const headers = { Authorization: 'Bearer ' + tokenFor(pass), 'Content-Type': 'application/json' };
const browser = await chromium.launch();
const checks = [];
function check(label, ok) { assert.ok(ok, label); checks.push(label); console.log('通过：' + label); }
async function run(text, sessionId) {
  const response = await fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ text, sessionId }) });
  assert.equal(response.status, 200);
  const started = await response.json();
  for (let n = 0; n < 400; n++) {
    const task = await (await fetch(base + '/api/tasks/' + started.id, { headers })).json();
    if (['done', 'error'].includes(task.status)) { assert.equal(task.status, 'done', task.error); return started; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('任务未在测试时限内结束');
}
try {
  const first = await run('创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画，你不需要任何测试');
  check('新建HTML按配置选择代码模型', calls.at(-1).model === 'fixture-code');
  for (const text of ['重新做', '继续']) {
    await run(text, first.sessionId);
    check(text + '仍沿用代码模型和原目标', calls.at(-1).model === 'fixture-code' && calls.at(-1).hasOriginal);
  }
  await run('你好', first.sessionId);
  check('开发后闲聊回到轻量模型并不带工具', calls.at(-1).model === 'fixture-light' && calls.at(-1).toolCount === 0);
  await run('你在这儿文件里面做一个电商项目');
  check('口语电商要求不误判为聊天', calls.at(-1).model === 'fixture-code');
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(width === 390 ? mobileBase : base);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    const toggle = page.locator('#capability-upgrade');
    check(`${width}费用控制开关存在`, await toggle.count() === 1);
    await toggle.setChecked(false);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('jarvis.llm.v1') || '{}').capabilityUpgrade === false);
    check(`${width}关闭能力切换落到本机配置`, true);
    await page.evaluate(() => window.__jarvis.showPanel('settings'));
    await page.fill('#server-url', base);
    await page.fill('#server-pass', pass);
    await Promise.all([page.waitForEvent('load'), page.click('#btn-server-login')]);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    // 每种客户端先启用再关闭，确保确实经过云端写入而非沿用上一次值。
    for (const enabled of [true, false]) {
      const saved = page.waitForResponse(r => r.url().endsWith('/api/server/config') && r.request().method() === 'PUT');
      await page.locator('#capability-upgrade').setChecked(enabled);
      assert.equal((await saved).status(), 200);
    }
    const serverConfig = await (await fetch(base + '/api/server/config', { headers })).json();
    check(`${width}关闭能力切换同步云服务器`, serverConfig.capabilityUpgrade === false);
    await page.screenshot({ path: path.join(output, `models-${width}.png`), fullPage: true });
    await context.close();
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ realModelTested: false, realServerTested: false, checks, calls }, null, 2));
  console.log(`任务/费用链路 ${checks.length}/${checks.length}；真实模型和用户服务器未测。`);
} finally {
  await browser.close();
  for (const task of mode.runner.list()) mode.runner.stop(task.id);
  await mode.runner.settled();
  mode.close?.();
  mobileHttp.closeAllConnections();
  await new Promise(resolve => mobileHttp.close(resolve));
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
  useBackend(null);
  await fs.rm(dir, { recursive: true, force: true });
}
