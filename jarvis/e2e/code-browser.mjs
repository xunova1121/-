/** 真Chromium、真断网只读容器；不调用模型/GitHub。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCodeBrowser } from '../server/codeBrowser.mjs';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-code-browser-e2e');
await fs.mkdir(output, { recursive: true });
const root = path.join(output, 'source');
await fs.mkdir(root, { recursive: true });
const html =
  '<!doctype html><meta name="viewport" content="width=device-width"><title>虚构商城</title><button id="add">加入购物袋</button><output id="count">0</output><script>let n=Number(localStorage.getItem("count")||0);count.textContent=n;add.onclick=()=>{count.textContent=++n;localStorage.setItem("count",n)};</script>';
await fs.writeFile(path.join(root, 'index.html'), html);
const browser = createCodeBrowser({ image: process.env.JARVIS_CODE_BROWSER_IMAGE || 'weiyang-code-browser:local', baseDir: path.join(output, 'jobs') });
const steps = [
  { action: 'assert', selector: '#count', expected: '0' },
  { action: 'click', selector: '#add' },
  { action: 'assert', selector: '#count', expected: '1' },
  { action: 'reload' },
  { action: 'assert', selector: '#count', expected: '1' }
];
const receipt = await browser.run({ root, files: ['index.html'], steps });
assert.equal(receipt.ok, true);
assert.equal(receipt.layoutOk, true);
assert.equal(receipt.checks.length, 5);
assert.deepEqual(receipt.errors, []);
assert.equal(receipt.network, 'container_offline');
await fs.writeFile(path.join(output, 'preview.png'), receipt.screenshotBytes);
await fs.writeFile(path.join(output, 'report.json'), receipt.reportBytes);
assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), html);
assert.equal(receipt.sourceDigest.length, 64);
assert.equal(createHash('sha256').update(receipt.screenshotBytes).digest('hex').length, 64);
const failed = await browser.run({ root, files: ['index.html'], steps: [{ action: 'assert', selector: '#count', expected: 'impossible' }] });
assert.equal(failed.ok, false);
assert.equal(failed.checks[0].ok, false);
assert.deepEqual(await fs.readdir(path.join(output, 'jobs')), []);
await fs.writeFile(
  path.join(output, 'summary.json'),
  JSON.stringify({ passed: true, checks: 5, negativeAssertion: true, cleanup: true, visual: 'not_human_reviewed', image: receipt.imageId }, null, 2)
);
console.log('隔离Chromium：5项真交互通过；错误断言真实失败；宿主原文件不变；容器清理确认');
