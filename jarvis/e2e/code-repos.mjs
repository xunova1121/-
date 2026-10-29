/** P1真实设置页 + 独立服务器API；GitHub上游用虚构回执，不执行测试仓库代码。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { codeError } from '../server/codeGit.mjs';
import { useBackend } from '../src/agent/store.js';

const out = process.argv[2] || '/tmp/weiyang-code-repos-e2e';
await fs.mkdir(out, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-repos-e2e-'));
const password = 'e2e-code-repositories';
const secret = 'ghp_' + 'DummyCredentialOnly'.repeat(3);
let saves = 0;
const hosting = {
  async repository(value) {
    saves++;
    if (value.token === 'rejected_token_1234567890') throw codeError('CODE_GITHUB_AUTH', 'GitHub令牌无效或已过期', { upstreamStatus: 401 });
    return { repository: value.repository, defaultBranch: 'main' };
  }
};
const mode = createServerMode({ dataDir, password, codeHosting: hosting });
await mode.ready;
const server = createServer({ serverMode: mode, ollama: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addInitScript(({ base, token }) => localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true })), {
      base,
      token: tokenFor(password)
    });
    const page = await context.newPage();
    const errors = [],
      logs = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => logs.push(message.text()));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis);
    await page.evaluate(() => window.__jarvis.showPanel('settings'));
    await page.locator('#code-repos-panel summary').click();
    await page.waitForFunction(() => /尚未连接|已连接/.test(document.querySelector('#code-repo-status').textContent));
    await page.fill('#code-repo-name', 'xunova1121/weiyang-code-sandbox');
    await page.fill('#code-repo-token', 'rejected_token_1234567890');
    await page.click('#code-repo-save');
    await page.waitForFunction(() => /GitHub令牌无效/.test(document.querySelector('#code-repo-status').textContent));
    assert.match(await page.textContent('#code-repo-capabilities'), /可修改任务分支/);
    assert.equal(await page.inputValue('#code-repo-token'), '');
    // 修改未登录的网址不能把PAT带到新地址；仍用已保存的登录服务器。
    await page.fill('#server-url', 'https://must-not-send.invalid');
    await page.fill('#code-repo-token', secret);
    await page.click('#code-repo-save');
    await page.waitForFunction(() => /已存令牌/.test(document.querySelector('#code-repo-status').textContent));
    assert.equal(await page.inputValue('#code-repo-token'), '');
    const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(disk.codeRepos.token, secret);
    assert.equal((await fs.stat(path.join(dataDir, 'config.json'))).mode & 0o777, 0o600);
    assert.equal(
      await page.evaluate(
        (secret) =>
          JSON.stringify(localStorage).includes(secret) || JSON.stringify(sessionStorage).includes(secret) || document.body.innerText.includes(secret),
        secret
      ),
      false
    );
    assert(!logs.join('\n').includes(secret));
    await page.screenshot({ path: path.join(out, `code-repos-${width}.png`) });
    const bounds = await page.locator('#code-repos-panel').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, '设置面板不应横向溢出');
    await page.reload();
    await page.waitForFunction(() => window.__jarvis);
    await page.evaluate(() => window.__jarvis.showPanel('settings'));
    await page.locator('#code-repos-panel summary').click();
    await page.waitForFunction(() => /已存令牌/.test(document.querySelector('#code-repo-status').textContent));
    assert.equal(await page.inputValue('#code-repo-token'), '');
    await page.click('#code-repo-disconnect');
    await page.waitForFunction(() => /尚未连接仓库/.test(document.querySelector('#code-repo-status').textContent));
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')).codeRepos, undefined);
    assert.deepEqual(errors, []);
    console.log(`✓ ${width}px 设置：鉴权失败、保存、刷新、断开、令牌仅服务器保存、已登录地址绑定`);
    await context.close();
  }
  assert.equal(saves, 4);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  useBackend(null);
  await fs.rm(dataDir, { recursive: true, force: true });
}
