/** P7真实浏览器→任务API→代码工具；仅虚构本地Git和模型回执，不冒充真实模型验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { DEFAULT_CONFIG } from '../src/llm/config.js';
import { useBackend } from '../src/agent/store.js';
import * as packs from '../src/agent/skillPacks.js';
import * as sessions from '../src/agent/sessions.js';
import { codeRepoFixture } from '../tests/helpers/codeRepoFixture.mjs';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-code-work');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch();
const bodyMarker = '先定位：GitHub项目用repo_clone';
const modelNames = { chat: 'fixture-chat', code: 'fixture-user-code', vision: 'gpt-4o-fixture-vision', pinned: 'fixture-pinned' };
const tool = (name, args, n) => ({ index: 0, id: 'fixture-' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const systemText = (request) =>
  request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

async function fixtureModel(state) {
  const host = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    state.requests.push(request);
    const n = state.step++;
    let delta = { content: '工作副本已保留。本轮没有运行lint或test，不声称测试通过。' };
    if (state.mode === 'budget') delta = { tool_calls: [tool('fixture_probe', { n }, n)] };
    if (['edit', 'resume', 'image'].includes(state.mode)) {
      if (n === 0) delta = { tool_calls: [tool('repo_clone', {}, n)] };
      else if (n === 1) delta = { tool_calls: [tool('code_read', { workspace_id: state.workspace, path: 'src/demo.mjs' }, n)] };
      else if (state.mode === 'edit' && n === 2)
        delta = { tool_calls: [tool('code_edit', { workspace_id: state.workspace, path: 'src/demo.mjs', old: 'n=1', new: 'n=2' }, n)] };
      else if (state.mode !== 'image') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '工作副本已保留，正在等待核对。' } }] }) + '\n\n');
        state.held = true;
        return; // 浏览器真实停止将中止连接；不伪造任务状态。
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({ choices: [{ delta }] }) +
        '\n\ndata: ' +
        JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) +
        '\n\ndata: [DONE]\n\n'
    );
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  return host;
}

async function configureCode(page, width) {
  await page.evaluate(() => window.__jarvis.showPanel('models'));
  await page
    .locator('#model-workspace .ml-tabs')
    .getByRole('button', { name: /云服务器/ })
    .click();
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/server/config') && response.request().method() === 'PUT');
  if (width < 600) {
    await page.getByRole('navigation', { name: '模型中心分类' }).getByRole('button', { name: '能力', exact: true }).click();
    await page.getByRole('button', { name: '配置编程', exact: true }).click();
    await page.getByRole('dialog', { name: '选择编程模型' }).getByRole('button').filter({ hasText: modelNames.code }).click();
  } else {
    const select = page.getByLabel('写代码 常用', { exact: true });
    const choice = await select.locator('option').allTextContents();
    await select.selectOption({ label: choice.find((label) => label.includes(modelNames.code)) });
  }
  assert.equal((await saved).status(), 200);
}

async function send(page, state, text, mode = 'answer', image = false) {
  state.requests.length = 0;
  state.step = 0;
  state.held = false;
  state.mode = mode;
  await page.evaluate(() => {
    document.body.classList.add('side-closed');
    document.body.classList.remove('side-open');
  });
  if (image) {
    const data = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#bceaff';
      ctx.fillRect(0, 0, 32, 32);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#file-input', { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    await page.waitForFunction(() => document.querySelector('#attach-list').children.length > 0);
  }
  await page.fill('#prompt', text);
  const started = page.waitForResponse((response) => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.click('#btn-send');
  const response = await started;
  assert(response.ok(), '浏览器任务必须被服务器实际接收');
  if (image) assert.equal(response.request().postDataJSON().images?.length, 1, '截图必须作为真实图像送达任务API');
  state.taskId = (await response.json()).id;
}
async function finish(page, runner) {
  await runner.settled();
  await page.waitForFunction(() => document.querySelector('.msg.agent') && !document.querySelector('.msg.agent.streaming'), null, { timeout: 30000 });
}
async function stop(page, state, runner) {
  await page.waitForFunction(() => document.querySelector('.msg.agent.streaming')?.textContent.includes('等待核对'));
  assert(state.held);
  await page.click('#btn-stop');
  await runner.settled();
  assert.equal(runner.list().at(-1).status, 'stopped');
}

async function skillChecks(page, state, runner, width) {
  await page.evaluate(() => window.__jarvis.showPanel('skills'));
  const card = page.locator('li.skill').filter({ has: page.locator('.skill-name', { hasText: '/code-development' }) });
  const tabs = page.locator('.wb-library-tabs');
  if (await tabs.isVisible()) await tabs.getByRole('button', { name: '我的技能', exact: true }).click();
  assert(await card.locator('label.switch input').isChecked());
  const [saved] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/skills/code-development') && response.request().method() === 'PATCH'),
    card.locator('label.switch').click()
  ]);
  assert.equal(saved.status(), 200);
  await page.waitForFunction(() => {
    const toggle = [...document.querySelectorAll('li.skill')].find((n) => n.textContent.includes('/code-development'))?.querySelector('label.switch input');
    return toggle && !toggle.checked && !toggle.disabled;
  });
  // 等待真实服务器回执，不把浏览器勾选状态当持久化成功。
  assert.equal((await packs.get('code-development')).enabled, false);
  await packs.seedBuiltins();
  await page.reload();
  await page.waitForFunction(() => window.__jarvis?.send);
  await send(page, state, '检查仓库代码的当前情况');
  await finish(page, runner);
  assert(!systemText(state.requests[0]).includes(bodyMarker));
  assert.equal((await packs.get('code-development')).enabled, false);
  await page.evaluate(() => window.__jarvis.showPanel('skills'));
  await card.getByRole('button', { name: '卸载', exact: true }).click();
  await card.getByRole('button', { name: '确认卸载', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('li.skill')].some((n) => n.textContent.includes('/code-development')));
  await packs.seedBuiltins();
  assert(!(await packs.get('code-development')));
  await page.reload();
  await page.waitForFunction(() => window.__jarvis?.send);
  await send(page, state, '检查仓库代码，说明还没验证的部分');
  await finish(page, runner);
  assert(!systemText(state.requests[0]).includes(bodyMarker));
  assert(!(await packs.get('code-development')));
  console.log(`✓ ${width}px 技能停用/卸载真实同步服务器，刷新与预置不重开`);
}

async function runViewport(width) {
  const f = await codeRepoFixture({ 'src/demo.mjs': 'export const n=1;\n' });
  const state = { requests: [], step: 0, mode: 'answer', workspace: null, held: false };
  const model = await fixtureModel(state);
  const cfgFile = path.join(f.directory, 'config.json');
  const cfg = {
    ...DEFAULT_CONFIG,
    provider: 'custom',
    models: { custom: modelNames.chat },
    keys: { custom: 'sk-fixture-only' },
    baseURLs: { custom: 'http://127.0.0.1:' + model.address().port + '/v1' },
    routing: { enabled: false },
    abilities: {
      code: { main: { provider: 'custom', model: 'fixture-initial' }, backup: null },
      vision: { main: { provider: 'custom', model: modelNames.vision }, backup: null }
    },
    favoriteModels: Object.values(modelNames).map((model) => ({ provider: 'custom', model })),
    codeRepos: f.cfg.codeRepos,
    autoMemory: false,
    hedgeBackup: false,
    embedding: { engine: 'off' },
    fallbackPolicy: 'explicit',
    fallbackModels: []
  };
  await fs.writeFile(cfgFile, JSON.stringify(cfg));
  const scopes = [];
  const clone = f.repos.clone;
  f.repos.clone = async (input, scope, execution) => {
    scopes.push(scope);
    const result = await clone(input, scope, execution);
    state.workspace = result.workspace_id;
    return result;
  };
  const runner = createTaskRunner({
    getConfig: async () => JSON.parse(await fs.readFile(cfgFile, 'utf8')),
    codeRepos: f.repos,
    maxSteps: 2,
    codeMaxSteps: 6, // 缩小等价预算测透传；默认28/80由原单测守护。
    makeTools: () => [
      {
        name: 'fixture_probe',
        description: '只用于有界预算回归的本地计数器',
        input_schema: { type: 'object', properties: { n: { type: 'integer' } } },
        run: async ({ n }) => JSON.stringify({ n })
      }
    ]
  });
  const mode = createServerMode({ dataDir: f.directory, password: 'p7-browser-fixture', runner });
  await mode.ready;
  const server = createServer({ serverMode: mode, ollama: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(
    ({ base, token }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false, autoMemory: false, teamMode: 'off' }));
    },
    { base, token: tokenFor('p7-browser-fixture') }
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.send);
    await configureCode(page, width);
    const chosen = JSON.parse(await fs.readFile(cfgFile, 'utf8'));
    assert.equal(chosen.abilities?.code?.main?.model, modelNames.code, '用户选择必须真实保存到服务器');
    await send(page, state, '检查GitHub仓库代码，读取并修改src/demo.mjs，不提交。', 'edit');
    await stop(page, state, runner);
    assert.equal(state.requests[0].model, modelNames.code);
    assert(systemText(state.requests[0]).includes(bodyMarker));
    const sessionId = await page.evaluate(() => window.__jarvis.sessionId);
    const originalId = scopes[0].taskId;
    const saved = await sessions.get(sessionId);
    saved.taskCheckpoint.steps = []; // 模拟长对话摘要不再带旧工具详情，持久索引仍须找回副本。
    await sessions.save(saved);
    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.send);
    await send(page, state, '继续', 'resume');
    await stop(page, state, runner);
    assert.equal(scopes.at(-1).taskId, originalId);
    assert(systemText(state.requests[0]).includes(state.workspace));
    await send(page, state, '继续，结合这张截图检查。', 'image', true);
    await finish(page, runner);
    assert.equal(state.requests[0].model, modelNames.vision);
    assert(JSON.stringify(state.requests[0].messages).includes('data:image/'));
    assert.equal(scopes.at(-1).taskId, originalId);
    assert.equal((await f.repos.workspaces(sessionId)).items.length, 1);
    assert((await f.repos.read(state.workspace, sessionId, 'src/demo.mjs')).lines[0].text.includes('n=2'));
    assert.equal(f.command(f.source, 'rev-parse', 'HEAD'), f.original);
    console.log(`✓ ${width}px 用户编程模型/技能生效；停止刷新后续做原脏副本；带图走用户识图模型`);
    await page.click('#model-chip');
    const [pinned] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/server/config') && response.request().method() === 'PUT'),
      page.locator('.ml-picker-item').filter({ hasText: modelNames.pinned }).click()
    ]);
    assert.equal(pinned.status(), 200);
    await page.locator('.ml-picker').waitFor({ state: 'hidden' });
    await send(page, state, '检查GitHub仓库代码，说明已有改动');
    await finish(page, runner);
    assert.equal(state.requests[0].model, modelNames.pinned);
    console.log(`✓ ${width}px 输入框固定型号优先，代码能力不擅自改回默认模型`);
    await send(page, state, '请完成例行检查', 'budget');
    await finish(page, runner);
    assert.equal(state.requests.length, 8, '普通预算仍是原2步×4自动扩步');
    assert(!systemText(state.requests[0]).includes(bodyMarker));
    await send(page, state, '检查GitHub仓库代码', 'budget');
    await finish(page, runner);
    assert.equal(state.requests.length, 6, '代码预算有独立硬上限，不继承普通扩步');
    console.log(`✓ ${width}px 浏览器任务透传普通预算和代码硬上限，普通对话不注入开发技能`);
    await skillChecks(page, state, runner, width);
    await page.screenshot({ path: path.join(out, `code-work-${width}.png`) });
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('P7浏览器失败：', error.message);
    await page.screenshot({ path: path.join(out, `failed-${width}.png`) });
    throw error;
  } finally {
    await context.close();
    for (const task of runner.list()) if (['queued', 'running'].includes(task.status)) runner.stop(task.id);
    await runner.settled();
    await new Promise((resolve) => server.close(resolve));
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    useBackend(null);
    await f.close();
  }
}
try {
  for (const width of [1280, 390]) await runViewport(width);
} finally {
  await browser.close();
}
