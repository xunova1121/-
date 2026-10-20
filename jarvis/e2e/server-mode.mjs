/**
 * 服务器模式端到端测试：先 npm run build，再执行
 *   node e2e/server-mode.mjs [截图输出目录]
 * 自己启动一个开了服务器模式的网关（临时数据目录、内置演示模型），用浏览器走一遍：
 * 登录 → 发任务（服务器上做）→ 生成文件下载到本机 → 刷新页面后对话从服务器取回 → 关掉服务器模式回到本机
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '.';
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'e2e-password-123';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-server-'));
const gw = spawn(process.execPath, ['server/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), JARVIS_DATA: dataDir, JARVIS_PASSWORD: PASS, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
gw.stdout.on('data', (d) => { log += d; });
gw.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 50 && !/服务器模式已开启/.test(log); i++) await new Promise((r) => setTimeout(r, 200));

const browser = await chromium.launch();
try {
  check('网关以服务器模式启动', /服务器模式已开启/.test(log), log.trim().split('\n').at(-1));
  check('没登录不能用接口', (await fetch(`${BASE}/api/sessions`)).status === 401);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis);
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await page.fill('#server-url', BASE);
  await page.fill('#server-pass', 'wrong-password');
  await page.click('#btn-server-login');
  await page.waitForFunction(() => /密码不对/.test(document.querySelector('#server-status').textContent));
  check('密码错了不让登录', true);
  await page.fill('#server-pass', PASS);
  await Promise.all([page.waitForEvent('load'), page.click('#btn-server-login')]);
  await page.waitForFunction(() => window.__jarvis);
  check('登录后保存的是令牌，不存密码', await page.evaluate((p) => { const s = localStorage.getItem('jarvis.server.v1'); return s.includes('"enabled":true') && !s.includes(p); }, PASS));

  // 发一个会写文件的任务（内置演示模型：说“写一个网页”会调用 write_file）
  await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
  await page.fill('#prompt', '帮我写一个网页');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => document.querySelector('#transcript .msg.agent') && !document.querySelector('#transcript .msg.agent.streaming'), null, { timeout: 30000 });
  const meta = await page.locator('#transcript .msg.agent').last().textContent();
  check('任务在服务器上做完，回答显示出来', meta.includes('服务器'), meta.slice(-80));
  const sessionsOnServer = fs.readdirSync(path.join(dataDir, 'store', 'sessions')).filter((f) => f.endsWith('.json'));
  check('对话存在服务器的数据目录里', sessionsOnServer.length === 1);
  const serverFiles = fs.existsSync(path.join(dataDir, 'store', 'files')) ? fs.readdirSync(path.join(dataDir, 'store', 'files')).filter((f) => f.endsWith('.json')).length : 0;
  const link = await page.locator('#transcript .msg.agent').last().locator('.file-link, [class*="file"]').count();
  check('服务器上生成的文件下载到了本机，回答里有文件链接可以打开', serverFiles > 0 && link > 0, `服务器 ${serverFiles} 个文件，链接 ${link} 个`);

  // 刷新页面：对话从服务器取回
  await page.reload();
  await page.waitForFunction(() => window.__jarvis);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .msg.agent').length > 0, null, { timeout: 10000 }).catch(() => {});
  check('刷新页面后，对话从服务器取回', await page.locator('#transcript .msg.user').count() >= 1);

  // 发任务后马上刷新（模拟手机切走 / App 被关）：任务在服务器上照样做完，再打开能看到结果
  await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
  await page.fill('#prompt', '再介绍一下你自己');
  await page.press('#prompt', 'Enter');
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForFunction(() => window.__jarvis);
  await page.waitForFunction(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('再介绍一下你自己')) && document.querySelectorAll('#transcript .msg.agent').length >= 2 && !document.querySelector('#transcript .msg.agent.streaming'), null, { timeout: 30000 }).catch(() => {});
  check('发完任务马上关掉页面，任务照样做完，再打开能看到结果', await page.evaluate(() => [...document.querySelectorAll('#transcript .msg.user')].some((m) => m.textContent.includes('再介绍一下你自己')) && document.querySelectorAll('#transcript .msg.agent').length >= 2));
  await page.screenshot({ path: path.join(OUT, 'server-mode.png') });

  check('输入框里显示服务器上设的模型', /^云端/.test(await page.locator('#model-chip-text').textContent()));
  // 本机设置不自动覆盖服务器；新界面明确编辑服务器模型。
  await page.evaluate(() => window.__jarvis.showPanel('models'));
  await page.locator('#model-advanced').evaluate(element => element.open = true);
  await page.selectOption('#llm-provider', 'custom');
  await page.fill('#llm-base', 'https://example.invalid/v1');
  await page.fill('#llm-model', 'local-only-model');
  await page.fill('#llm-key', 'sk-local-only');
  await page.click('#btn-llm-save');
  await page.waitForTimeout(1000);
  check('本机修改不会覆盖服务器模型或密钥', !fs.existsSync(path.join(dataDir, 'config.json')) || !fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').includes('sk-local-only'));
  await page.locator('#model-workspace .ml-add-select').selectOption('custom');
  await page.locator('.ml-provider').filter({hasText:'自定义（OpenAI 兼容）'}).getByRole('button', {name:'配置 ›',exact:true}).click();
  const editor=page.locator('.ml-editor');
  await editor.getByLabel('接口地址',{exact:true}).fill('https://example.invalid/v1');
  await editor.getByLabel('API Key',{exact:true}).fill('sk-server-only');
  await editor.getByLabel('手动模型 ID',{exact:true}).fill('synced-model');
  await editor.getByRole('button',{name:'保存服务商',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-model="synced-model"]'));
  await page.locator('[data-model="synced-model"]').getByRole('button',{name:'设默认',exact:true}).click();
  await page.waitForFunction(() => /synced-model/.test(document.querySelector('#model-chip-text').textContent));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  check('明确编辑服务器默认模型并更新云端标签', saved.provider==='custom'&&saved.models.custom==='synced-model'&&saved.keys.custom==='sk-server-only');
  check('服务器配置不会写入本机模型或密钥',await page.evaluate(()=>{const cfg=JSON.parse(localStorage.getItem('jarvis.llm.v1'));return cfg.models.custom==='local-only-model'&&cfg.keys.custom==='sk-local-only'&&!JSON.stringify(cfg).includes('sk-server-only');}));

  // 关掉服务器模式：回到本机
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await Promise.all([page.waitForEvent('load'), page.uncheck('#server-on')]);
  await page.waitForFunction(() => window.__jarvis);
  check('关掉服务器模式，回到本机的对话', await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.server.v1')).enabled === false) && await page.locator('#transcript .msg.user').count() === 0);
  check('没有页面错误', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  gw.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n服务器模式 ${results.filter(Boolean).length}/${results.length} 通过`);
if (results.some((x) => !x)) process.exitCode = 1;
