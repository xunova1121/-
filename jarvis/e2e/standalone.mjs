/**
 * 单文件版测试：直接用 file:// 打开 jarvis-standalone.html（不启动任何服务器）。
 *   npm run build:standalone && node e2e/standalone.mjs [截图目录]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = pathToFileURL(path.resolve(here, '../../jarvis-standalone.html')).href;
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 140)}` : ''}`);
};
async function ask(page, q) {
  const before = await page.locator('#transcript .msg.agent').count();
  await page.fill('#prompt', q);
  await page.press('#prompt', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout: 40000 });
  await page.waitForTimeout(150);
  return page.locator('#transcript .msg.agent').last().innerText();
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 } });
const page = await ctx.newPage();
const errors = [];
const requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(m.text().slice(0, 200)); });
page.on('request', (r) => requests.push(r.url()));

await page.goto(FILE);
await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 10, null, { timeout: 30000 });
const stats = await page.evaluate(() => window.__jarvis.stage.stats);
check('双击打开即渲染（file://，无服务器）', true, `${stats.style} / ${stats.drawCalls} draw calls`);
check('单文件版标识', (await page.textContent('#gw-badge')) === '单文件版');

let reply = await ask(page, '帮我写一个网页');
await page.waitForTimeout(600);
check('写网页并预览', /\d{1,2}:\d{2}:\d{2}/.test(await page.frameLocator('#viewer-body iframe').locator('#t').textContent().catch(() => '')));
reply = await ask(page, '做一个PPT');
check('生成 PPT', /示例\.pptx/.test(reply), reply.slice(-60));
reply = await ask(page, '运行一段代码');
check('运行代码（沙箱 Worker）', /返回值：55/.test(reply));

await page.click('[data-panel="knowledge"]');
const pdfPage = await ctx.newPage();
await pdfPage.setContent('<p>出差补贴标准：一线城市每天 300 元，其他城市每天 200 元。</p>');
const pdf = await pdfPage.pdf({ format: 'A4' });
await pdfPage.close();
await page.setInputFiles('#kb-input', { name: '差旅制度.pdf', mimeType: 'application/pdf', buffer: pdf });
await page.waitForFunction(() => document.querySelectorAll('#kb-list li:not(.empty)').length >= 1, null, { timeout: 20000 }).catch(() => {});
check('导入 PDF 到知识库（内联 pdf.js Worker）', /差旅制度\.pdf/.test(await page.textContent('#kb-list')), await page.textContent('#kb-list'));
reply = await ask(page, '根据知识库，出差补贴标准是多少？');
check('依据知识库回答', /300/.test(reply), reply.slice(0, 80));

await ask(page, '记住我在上海工作');
await page.click('[data-panel="mind"]');
await page.waitForTimeout(300);
check('记住信息', /我在上海工作/.test(await page.textContent('#mind-list')));
await page.screenshot({ path: `${OUT}/standalone.png` });

await page.click('[data-panel="models"]');
await page.selectOption('#llm-provider', 'qwen');
check('不允许浏览器直连的服务商有提示', /启动\.bat/.test(await page.textContent('#llm-note')));

const external = requests.filter((u) => !/^(file|data|blob):/.test(u) && !/fonts\.(googleapis|gstatic)\.com/.test(u) && u !== 'http://127.0.0.1:8787/api/health');
check('除可选的网页字体外不依赖网络', external.length === 0, external.join(' | '));
check('无页面错误', errors.length === 0, errors.join(' | '));

// —— 双击 启动.bat 后：单文件版自动连上本机网关，不允许跨域的接口也能用
{
  // 一个不带任何跨域响应头的 OpenAI 兼容接口（模拟中转服务）
  const seen = [];
  const relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '<emotion>亲和</emotion>经由本机网关转发成功。' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const gw = spawn(process.execPath, ['--import', path.resolve(here, 'dns-preload.mjs'), path.resolve(here, '../server/server.mjs')], { env: { ...process.env, PORT: '8787', ANTHROPIC_API_KEY: '' }, stdio: 'ignore' });
  process.on('exit', () => gw.kill());
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch('http://127.0.0.1:8787/api/health')).ok) break; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const p2 = await ctx.newPage();
  await p2.goto(FILE);
  await p2.waitForFunction(() => window.__jarvis?.showPanel);
  await p2.evaluate(() => window.__jarvis.showPanel('models'));
  await p2.waitForFunction(() => /已连网关/.test(document.querySelector('#gw-badge').textContent), null, { timeout: 10000 }).catch(() => {});
  check('自动连上本机网关', /已连网关/.test(await p2.textContent('#gw-badge')));
  await p2.selectOption('#llm-provider', 'custom');
  await p2.fill('#llm-base', `http://relay-${relay.address().port}.test:${relay.address().port}/v1`);
  await p2.fill('#llm-model', 'gpt-x');
  await p2.fill('#llm-key', 'sk-relay');
  await p2.click('#btn-llm-save');
  const r2 = await ask(p2, '你好');
  check('不允许跨域的自定义接口经网关转发成功', /经由本机网关转发成功/.test(r2), r2.slice(0, 80));
  check('转发时带上用户自己的密钥', seen[0]?.auth === 'Bearer sk-relay' && seen[0]?.url === '/v1/chat/completions', JSON.stringify(seen[0]));
  gw.kill();
  relay.close();
}

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
