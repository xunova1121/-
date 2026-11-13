/** 真实手机版构建：新问题FIFO、补充原任务、撤回和停止暂停；请求用可控本机模型，不调用付费服务。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('dist-mobile');
const requests = [];
const held = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); requests.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const text = content => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    text('正在整理你的要求。');
    const finish = () => {
      if (!res.destroyed) {
        text('本次任务已完成。');
        res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }
    };
    held.push(finish);
    return;
  }
  try {
    const target = path.resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!target.startsWith(root + path.sep)) throw new Error('outside');
    const data = await readFile(target);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[path.extname(target)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser;
const lastUser = request => [...request.messages].reverse().find(row => row.role === 'user')?.content;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(base => {
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false, autoMemory: false, teamMode: 'off' }));
    localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'custom', models: { custom: 'queue-test' }, keys: { custom: 'fixture' }, baseURLs: { custom: base + '/v1' }, routing: { enabled: false }, hedgeBackup: false }));
  }, base);
  const page = await context.newPage(); await page.goto(base);
  await page.waitForFunction(() => window.__jarvis?.send);
  const submit = async text => { await page.fill('#prompt', text); await page.click('#btn-send'); };
  await submit('请介绍甲方案');
  await page.waitForSelector('.msg.agent.streaming .body');
  await page.waitForFunction(() => document.querySelector('.composer-send-modes') && !document.querySelector('.composer-send-modes').hidden);
  await page.getByRole('button', { name: '排队新问题', exact: true }).click();
  await submit('请介绍乙方案'); await submit('请介绍丙方案'); await submit('这条请取消');
  const queue = page.getByRole('region', { name: '待发送问题' });
  assert.equal(await queue.locator('li').count(), 3);
  await queue.locator('li').last().getByRole('button', { name: '移除' }).click();
  assert.equal(await queue.locator('li').count(), 2);
  assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(requests[0]).includes('乙方案'));
  assert.equal(await page.locator('#prompt').inputValue(), '');
  held.shift()();
  await page.waitForFunction(() => document.querySelectorAll('.msg.user').length >= 2);
  await assertEventually(() => requests.length === 2);
  assert.equal(lastUser(requests[1]), '请介绍乙方案');
  assert.ok(!JSON.stringify(requests[1]).includes('丙方案'));
  assert.ok(!JSON.stringify(requests[1]).includes('这条请取消'));
  assert.equal(await queue.locator('li').count(), 1);
  held.shift()();
  await assertEventually(() => requests.length === 3);
  assert.equal(lastUser(requests[2]), '请介绍丙方案');
  assert.equal(await queue.isVisible(), false);
  await page.getByRole('button', { name: '排队新问题', exact: true }).click();
  await submit('停止后不自动发送的丁方案');
  await page.click('#btn-stop');
  await page.waitForFunction(() => document.querySelector('.composer-message-queue')?.textContent.includes('已暂停'));
  assert.equal(requests.length, 3);
  await queue.getByRole('button', { name: '继续队列' }).click();
  await assertEventually(() => requests.length === 4);
  assert.equal(lastUser(requests[3]), '停止后不自动发送的丁方案');
  await page.click('#btn-stop');
  for (const finish of held.splice(0)) finish();
  await page.waitForFunction(() => !document.body.classList.contains('generating'));
  await submit('请介绍原会话甲方案');
  await assertEventually(() => requests.length === 5);
  const original = await page.evaluate(() => window.__jarvis.sessionId);
  await page.setInputFiles('#file-input', { name: '排队材料.txt', mimeType: 'text/plain', buffer: Buffer.from('只属于排队问题的材料') });
  await page.waitForFunction(() => document.querySelector('#attach-list')?.textContent.includes('排队材料.txt'));
  await page.getByRole('button', { name: '排队新问题', exact: true }).click();
  await submit('原会话排队的戊方案');
  await page.evaluate(() => window.__jarvis.newSession());
  await page.waitForFunction(original => window.__jarvis.sessionId !== original, original);
  assert.equal(await queue.isVisible(), false);
  await page.fill('#prompt', '新会话未发送的草稿');
  await page.setInputFiles('#file-input', { name: '草稿材料.txt', mimeType: 'text/plain', buffer: Buffer.from('只属于未发送草稿的材料') });
  await page.waitForFunction(() => document.querySelector('#attach-list')?.textContent.includes('草稿材料.txt'));
  held.shift()();
  await page.waitForFunction(async original => (await window.__jarvis.sessionGet(original))?.messages.at(-1)?.role === 'assistant', original);
  assert.equal(requests.length, 5);
  await page.evaluate(original => window.__jarvis.openSession(original), original);
  await page.waitForFunction(() => document.querySelector('.composer-message-queue')?.textContent.includes('已暂停'));
  await queue.getByRole('button', { name: '继续队列' }).click();
  await assertEventually(() => requests.length === 6);
  assert.ok(lastUser(requests[5]).includes('原会话排队的戊方案'));
  assert.ok(lastUser(requests[5]).includes('排队材料.txt'));
  assert.ok(!lastUser(requests[5]).includes('草稿材料.txt'));
  assert.equal(await page.locator('#prompt').inputValue(), '新会话未发送的草稿');
  assert.ok((await page.locator('#attach-list').textContent()).includes('草稿材料.txt'));
  await page.click('#btn-stop');
  console.log('通过：手机可见队列按乙、丙逐条执行、不污染当前上下文，取消有效，停止后暂停且只在明确继续时发送。');
  console.log('通过：切换会话不串发，回原会话明确继续，排队附件和当前草稿附件分别保留。');
} finally {
  for (const finish of held) finish();
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

async function assertEventually(check) {
  for (let n = 0; n < 150; n++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(check(), '预期的下一条请求没有按时到达');
}
