/** 真实Chromium与应用模块；Share/App生命周期为模拟，不冒充安卓真机或微信实测。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '/tmp/weiyang-share-return');
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'failure.json'), { force: true });
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>未央分享返回验收</title><style>body{font:16px system-ui;margin:24px;color:#24364c;background:#f6f8fc}button,input{font:inherit;padding:12px;margin:8px 0;border:1px solid #c9d3e0;border-radius:10px;background:white}button{display:block}section{padding:16px;background:white;border-radius:16px;white-space:pre-wrap}#error{color:#a22}p{overflow-wrap:anywhere}</style></head><body><h1>分享返回验收</h1><p>原生事件模拟 · 不是真微信</p><p id="foreground">未央前台</p><p id="session"></p><section id="transcript"></section><div id="viewer"><p id="viewer-name"></p></div><button id="share">分享到微信（模拟）</button><button id="new-session">打开另一段对话</button><input id="prompt" placeholder="页面始终可以输入"><p id="result"></p><p id="error"></p><script type="module" src="/e2e/fixtures/share-return.mjs"></script></body></html>`;
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'share-return-fixture', configureServer(vite) {
  vite.middlewares.use('/__share-return', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
} }] });
const checks = [], errors = [], requests = [];
const check = (label, pass, detail) => { checks.push({ label, pass: Boolean(pass), detail }); assert.ok(pass, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); console.log('✓ ' + label); };
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}/__share-return`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') requests.push(request.url()); });
  const ready = () => page.waitForFunction(() => window.shareFixture?.ready);
  const state = () => page.evaluate(() => ({ calls: shareFixture.calls, pending: shareFixture.pending(), raw: shareFixture.rawPending(), notice: shareFixture.notice() }));
  await page.goto(base); await ready();
  check('真实DOM与IndexedDB会话已准备', await page.locator('#session').textContent() === 'c_share_original' && (await page.locator('#transcript').textContent()).includes('保留这个海报'));
  await page.locator('#share').dblclick({ delay: 0 });
  await page.waitForFunction(() => shareFixture.calls.share.length === 1 && document.getElementById('error').textContent.includes('进行中'));
  let snapshot = await state();
  check('实际按钮连续点击只发起一次原生分享', snapshot.calls.share.length === 1 && snapshot.calls.writes.length === 1);
  check('没有把调用发起冒称发送成功', (await page.locator('#result').textContent()).includes('已请求打开') && !(await page.locator('#result').textContent()).includes('分享成功'));
  check('返回通知与最小恢复指针在离开前准备', snapshot.notice === snapshot.pending.id && snapshot.pending.sessionId === 'c_share_original' && snapshot.pending.filePath === '分享验收/原图.png');
  check('指针不保存凭证、正文或图片', !/fixture-only-login|保留这个海报|base64|EXTRA_STREAM/.test(snapshot.raw));
  const bytes = await page.evaluate(() => shareFixture.originalBytes());
  check('真实PNG原字节完整传给分享插件', Buffer.from(snapshot.calls.writes[0].data, 'base64').equals(Buffer.from(bytes)));
  await page.evaluate(() => { shareFixture.foreground(false); shareFixture.foreground(true); });
  await page.waitForTimeout(100);
  await page.evaluate(() => { shareFixture.foreground(false); shareFixture.resolve(); });
  await page.waitForTimeout(900);
  snapshot = await state();
  check('选择器短暂resume后进入微信，返回入口仍保留', snapshot.notice === snapshot.pending?.id && snapshot.calls.finish.length === 0);
  await page.locator('#new-session').click();
  await page.evaluate(() => shareFixture.foreground(true));
  await page.waitForFunction(() => !shareFixture.pending() && !shareFixture.notice());
  check('稳定返回清理通知与指针', true);
  check('正常返回不抢走用户新开的会话', await page.locator('#session').textContent() === 'c_user_new');
  await page.locator('#prompt').fill('返回后仍能输入');
  check('返回后页面没有遮罩或交互锁', await page.locator('#prompt').inputValue() === '返回后仍能输入');

  await page.evaluate(() => { shareFixture.setNotification(false); document.getElementById('error').textContent = ''; });
  await page.locator('#share').click();
  await page.waitForFunction(() => shareFixture.calls.share.length === 2);
  snapshot = await state();
  check('通知不可用仍可分享，不请求额外权限', snapshot.notice === null && snapshot.calls.share.length === 2);
  check('不同次同名文件使用不同缓存路径', snapshot.calls.writes[0].path !== snapshot.calls.writes[1].path);
  await page.evaluate(() => shareFixture.reject());
  await page.waitForFunction(() => !shareFixture.pending());
  check('取消分享清理状态且不弹失败提示', (await state()).calls.toasts.length === 0);
  await page.evaluate(() => { shareFixture.fillRecentCache(); document.getElementById('error').textContent = ''; });
  await page.locator('#share').click();
  await page.waitForFunction(() => document.getElementById('error').textContent.includes('空间已满'));
  snapshot = await state();
  check('64份近期缓存时停止新增且不删除微信可能读取的文件', snapshot.calls.share.length === 2 && snapshot.calls.writes.length === 2 && snapshot.calls.removed.length === 0);
  await page.screenshot({ path: path.join(output, 'returned.png'), fullPage: true });

  // 重新进入原会话，保留相同origin的IndexedDB和localStorage，再模拟WebView进程重建。
  await page.goto(base); await ready();
  await page.locator('#share').click();
  await page.waitForFunction(() => shareFixture.calls.share.length === 1);
  await page.evaluate(() => shareFixture.foreground(false));
  await page.goto(base + '?restore=1'); await ready();
  snapshot = await state();
  check('同账号重建从真实存储恢复原会话', await page.locator('#session').textContent() === 'c_share_original' && (await page.locator('#transcript').textContent()).includes('保留这个海报'));
  check('重建恢复没有重发或调用反思', snapshot.calls.send === 0 && snapshot.calls.reflect === 0 && snapshot.calls.switch === 1);
  check('重建恢复完成清掉旧通知与指针', snapshot.pending === null && snapshot.notice === null);
  await page.screenshot({ path: path.join(output, 'restored.png'), fullPage: true });

  await page.locator('#share').click();
  await page.waitForFunction(() => shareFixture.calls.share.length === 1);
  await page.evaluate(() => shareFixture.foreground(false));
  await page.goto(base + '?restore=1&slow=1');
  await page.waitForFunction(() => window.shareFixture?.waiting);
  await page.locator('#new-session').click();
  check('恢复等待时空会话新建保留ID并实际聚焦输入框', await page.locator('#session').textContent() === 'c_empty' && await page.locator('#prompt').evaluate(element => element === document.activeElement));
  await page.locator('#prompt').fill('新的问题留在新会话');
  await page.evaluate(() => shareFixture.allowRead()); await ready();
  snapshot = await state();
  check('实际新建处理器阻止慢网恢复覆盖空会话与草稿', await page.locator('#session').textContent() === 'c_empty' && await page.locator('#prompt').inputValue() === '新的问题留在新会话' && snapshot.calls.switch === 0 && snapshot.calls.send === 0 && snapshot.calls.reflect === 0);

  await page.goto(base); await ready();
  await page.locator('#share').click();
  await page.waitForFunction(() => shareFixture.calls.share.length === 1);
  await page.evaluate(() => { shareFixture.foreground(false); shareFixture.changeAccount(); });
  await page.goto(base + '?restore=1'); await ready();
  snapshot = await state();
  check('换账号重建不能恢复旧账号会话或正文', await page.locator('#session').textContent() === 'c_empty' && !(await page.locator('#transcript').textContent()).includes('保留这个海报') && snapshot.calls.switch === 0);
  check('身份不匹配不重新提交任务，旧入口已清理', snapshot.calls.send === 0 && snapshot.calls.reflect === 0 && snapshot.pending === null && snapshot.notice === null);
  check('检查中无页面异常或外部网络请求', errors.length === 0 && requests.length === 0, { errors, requests });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ actualAndroidDevice: false, actualWechat: false, nativeShareAndAppLifecycle: 'simulated', browser: 'Chromium', realStorage: ['IndexedDB', 'localStorage'], checks }, null, 2));
  console.log(`分享返回 ${checks.length}/${checks.length}；原生事件模拟，安卓真机与微信未测。`);
  await context.close();
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, checks, errors, requests }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }
