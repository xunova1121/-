/** 实际项目菜单组件的浏览器检查；GitHub响应是显式夹具，无真实远端写操作。 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const output = process.argv[2] || '/tmp/weiyang-code-project-ui';
await fs.mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = 'http://127.0.0.1:' + server.httpServer.address().port;
const browser = await chromium.launch();
let checks = 0;
try {
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/e2e/fixtures/code-projects.html');
    await page.waitForFunction(() => window.fixtureReady);
    assert.equal(await page.locator('.composer-row #project-chip').count(), 0, '项目不占用输入框');
    assert.equal(await page.locator('#project-chip').isVisible(), false, '旧调用目标不重复显示');
    assert.equal(await page.getByRole('button', { name: '代码项目', exact: true }).count(), 1, '导航保留项目入口');
    checks += 3;
    await page.getByRole('button', { name: '代码项目', exact: true }).click();
    await page.getByText('GitHub · demo', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'demo/example' }).getAttribute('href'), 'https://github.com/demo/example');
    checks++;
    await page.getByRole('button', { name: '继续此副本' }).click();
    await page.waitForFunction(() => fixtureCalls.some((v) => v[0] === 'select'));
    checks++;
    await page.getByRole('button', { name: '页面预览', exact: true }).click();
    await page.frameLocator('iframe').locator('#isolation').filter({ hasText: 'isolated' }).waitFor();
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    checks++;
    await page.getByRole('button', { name: '关闭预览' }).click();
    await page.locator('[data-create] input[name=name]').fill('new-example');
    await page.locator('[data-create] input[name=title]').fill('虚构新项目');
    await page.getByRole('button', { name: '准备创建', exact: true }).click();
    await page.getByText('demo/new-example · 将新建工作分支', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => fixtureCalls.filter((v) => v[0] === 'confirm').length), 0);
    assert.equal(await page.evaluate(() => fixtureCalls.find((v) => v[0] === 'prepare')[1].private), true);
    checks += 2;
    await page.screenshot({ path: output + '/project-' + width + '.png' });
    await page.getByRole('button', { name: '确认创建并准备分支' }).click();
    await page.waitForFunction(() => fixtureCalls.some((v) => v[0] === 'confirm'));
    assert.equal(await page.evaluate(() => fixtureCalls.filter((v) => v[0] === 'confirm').length), 1);
    checks++;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    checks += 2;
    await page.close();
  }
  await fs.writeFile(
    output + '/summary.json',
    JSON.stringify({ passed: true, checks, widths: [320, 390, 1440], github: 'fixture', preview: 'real opaque sandbox' }, null, 2)
  );
  console.log('项目菜单：' + checks + '项浏览器检查通过');
} finally {
  await browser.close();
  await server.close();
}
