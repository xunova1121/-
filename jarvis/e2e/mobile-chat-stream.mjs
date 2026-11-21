/** 从实际手机版发送两轮消息。模型使用本地 SSE，可在指定分段暂停，验证未完成的答复能及时显示和恢复。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = path.resolve(process.env.WORKSHOP_MOBILE_DIST || 'dist-mobile');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2'
};
const questions = ['用一句话描写窗台。', '继续用短句描写窗台。'];
const beginning = ['晨光照在窗台上。', '窗前有一只橘猫。'];
const middle = Array.from({ length: 64 }, (_, i) => '第' + (i + 1) + '步。').join('');
const endings = ['窗边很安静。', '小猫轻轻收起爪子。'];
const expected = [beginning[0] + endings[0], beginning[1] + middle + endings[1]];

function writeToken(response, content) {
  response.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\n');
}

async function check(browser, safe) {
  const pending = [];
  const timings = [];
  const errors = [];
  const crashes = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const received = Date.now();
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const { messages } = JSON.parse(Buffer.concat(buffers).toString());
        const i = pending.length;
        assert.equal(messages.filter(m => m.role === 'user').at(-1)?.content, questions[i]);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const done = () => {
          writeToken(res, endings[i]);
          res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        };
        pending.push({ received, firstWrite: Date.now(), res, done });
        writeToken(res, beginning[i]);
        return;
      }
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(bytes);
    } catch (error) {
      if (req.method === 'POST') errors.push(error.message);
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.route(/^https?:\/\//, route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.addInitScript(({ base, safe }) => {
      localStorage.setItem('jarvis.renderSafe', String(safe));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', autoMemory: false, speechOutput: false, teamMode: 'off' }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({
        provider: 'custom', models: { custom: 'stream-test' }, keys: { custom: 'fixture' },
        baseURLs: { custom: base + '/v1' }, routing: { enabled: false }, hedgeBackup: false
      }));
    }, { base, safe });
    const page = await context.newPage();
    page.on('crash', () => crashes.push('renderer'));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.send && document.body.classList.contains('compact'));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('safe-render')), safe);
    const cdp = await context.newCDPSession(page);
    const sessionId = await page.evaluate(() => window.__jarvis.sessionId);
    const bodies = page.locator('#transcript .msg.agent .body');
    for (const [i, question] of questions.entries()) {
      await page.fill('#prompt', question);
      await page.evaluate(() => document.querySelector('#btn-send').addEventListener('click', () => {
        window.__streamClick = Date.now();
      }, { once: true, capture: true }));
      await page.click('#btn-send');
      // The server has supplied no end marker. A consumer that buffers the full response cannot pass this assertion.
      await page.waitForFunction(({ i, first }) => {
        if (!document.querySelectorAll('#transcript .msg.agent .body')[i]?.textContent.includes(first)) return false;
        window.__streamVisible = Date.now();
        return true;
      }, { i, first: beginning[i] });
      const [clicked, shown] = await page.evaluate(() => [window.__streamClick, window.__streamVisible]);
      const record = pending[i];
      assert(record && !record.res.writableEnded);
      timings.push({ sendToRequestMs: record.received - clicked, firstWriteToObservedMs: shown - record.firstWrite });
      if (i === 1) {
        assert.equal(await page.locator('#transcript .msg').count(), 4);
        await page.locator('#transcript').evaluate(el => { el.scrollTop = 0; });
        await page.evaluate(() => {
          window.__jarvisForeground = false;
          dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: false } }));
        });
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        for (const token of middle.match(/.{1,5}/gu)) {
          writeToken(record.res, token);
          await delay(5);
        }
        record.done();
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        await page.evaluate(() => {
          window.__jarvisForeground = true;
          dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active: true } }));
        });
      } else {
        record.done();
      }
      await page.waitForFunction(({ i, last }) => !document.body.classList.contains('generating') &&
        document.querySelectorAll('#transcript .msg.agent .body')[i]?.textContent.includes(last), { i, last: endings[i] });
      assert.equal(await bodies.nth(i).textContent(), expected[i]);
    }
    const stored = await page.evaluate(async id => (await window.__jarvis.sessionGet(id)).messages
      .filter(m => m.role === 'assistant').map(m => m.content), sessionId);
    assert.deepEqual(stored, expected, '持久化的正文应逐字保留所有分段');
    const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
    await page.getByRole('button', { name: '看未央工作', exact: true }).click();
    const room = page.locator('#mobile-work-studio');
    await room.locator('img.ws-nest-art').waitFor();
    await room.getByRole('button', { name: '返回对话' }).click();
    await room.waitFor({ state: 'hidden' });
    assert.equal(await bodies.nth(1).textContent(), expected[1]);
    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.send);
    await page.evaluate(id => window.__jarvis.openSession(id), sessionId);
    await bodies.nth(1).waitFor();
    assert.equal(await bodies.nth(1).textContent(), expected[1]);
    assert.equal(pending.length, 2, '恢复前台、进出工作台与重开会话不得重发模型请求');
    assert.deepEqual(errors, []);
    assert.deepEqual(crashes, []);
    console.log(browser.version(), safe ? '兼容显示' : '标准显示', '四条消息，节点', nodes,
      '；流中正文、恢复后尾段、工作台和持久化通过。', JSON.stringify(timings));
  } finally {
    for (const request of pending) if (!request.res.writableEnded) request.res.end();
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const browser = await chromium.launch({ executablePath: process.env.WORKSHOP_CHROMIUM_EXECUTABLE });
try {
  await check(browser, true);
  await check(browser, false);
} finally {
  await browser.close();
}
