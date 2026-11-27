/** 真实手机版构建+服务器模式+本机假模型，验证上传图片连续四轮实际送达，不访问付费接口。 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const prompts = ['描述这张图', '描述场景', '发散三个创意', '写一段文案'];
const requests = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  res.setHeader('Content-Type', 'text/event-stream');
  res.end('data: '+JSON.stringify({choices:[{delta:{content:'依据图片的测试描述和创意。'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-image-followup-'));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  provider: 'custom', models: { custom: 'gpt-4o-mini' }, keys: { custom: 'fixture-key' },
  baseURLs: { custom: `http://127.0.0.1:${upstream.address().port}/v1` }, routing: { enabled: false }
}));
const base = 'http://127.0.0.1:8793';
const gateway = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: '8793', JARVIS_DATA: data, JARVIS_PASSWORD: 'fixture-password' }, stdio: 'pipe'
});
let logs = '';
gateway.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-30000); });
gateway.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-30000); });
const root = path.resolve('dist-mobile');
const web = http.createServer((req, res) => {
  const file = path.resolve(root, new URL(req.url, 'http://x').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (gateway.exitCode !== null) throw Error('测试服务器提前退出');
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, '测试服务器未就绪');
  const login = await fetch(base + '/api/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) });
  const { token } = await login.json();
  assert.ok(token);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ base, token }) => {
    localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false, autoMemory: false, teamMode: 'off' }));
  }, { base, token });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${web.address().port}`);
  await page.waitForFunction(() => window.__jarvis?.send);
  await page.setInputFiles('#file-input', { name: '场景.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForFunction(() => document.querySelector('#attach-list')?.children.length > 0);
  for (const prompt of prompts) {
    const count = await page.locator('.msg.agent').count();
    await page.fill('#prompt', prompt);
    await page.click('#btn-send');
    await page.waitForFunction((count) => document.querySelectorAll('.msg.agent').length > count && !document.querySelector('.msg.agent.streaming'), count, { timeout: 30000 });
    const request = requests.findLast((item) => {
      const current = item.messages.at(-1);
      const content = current?.content;
      const text = Array.isArray(content) ? content.find((part) => part.type === 'text')?.text : content;
      return current?.role === 'user' && text?.startsWith(prompt);
    });
    assert.ok(request, '模型未收到当前追问');
    assert.ok(request.messages.at(-1).content.some((part) => part.type === 'image_url'), '当前云端请求丢失图片');
    assert.ok(!(request.tools || []).some((tool) => ['web_search', 'fetch_url', 'delegate_task'].includes(tool.function?.name)), '创作仍提供了检索工具');
    console.log(`✓ 云端图片追问实际带图且不提供检索：${prompt}`);
  }
  const transcript = await page.locator('#transcript').innerText();
  assert.ok(!/检索已停止|部分完成/.test(transcript));
  console.log('✓ 描述、发散、文案链路没有检索停止警告');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  gateway.kill();
  upstream.closeAllConnections();
  web.closeAllConnections();
  await Promise.all([new Promise((resolve) => upstream.close(resolve)), new Promise((resolve) => web.close(resolve))]);
}
