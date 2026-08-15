/**
 * 界面走查：在**真的浏览器**里点一遍「开始」，把设定集和分镜两步跑完。
 *
 * ── 为什么单独一个脚本 ──
 *
 * scripts/selftest.mjs 验的是服务端：接口回什么、盘上存了什么。它全绿，
 * 界面照样可能一动不动 —— 这个坑真的踩过：一次重构把"跑完要不要重画"
 * 判断成了 `job.stage`，而收尾时那个字段**先被清成 null 才通知界面**，
 * 于是判断永远为假，设定集和分镜跑完页面什么都不显示。
 * 服务端一切正常，567 项自检全绿，而用户看到的是"生成完没东西"。
 *
 * 那种 bug 只有把浏览器拉起来、真的点一次按钮才抓得到。
 *
 * ── 怎么跑 ──
 *
 *   node scripts/uicheck.mjs
 *
 * 需要本机有 Playwright（`npm i -g playwright` 或设 PLAYWRIGHT_PATH）。
 * CI 不跑它 —— 打包机上装一套浏览器不值当，而这个脚本是给改完界面的人用的。
 * 上游全部打桩，不联外网、不花钱。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Playwright 不是这个项目的依赖，从全局装的那份里取。找不到就说清楚怎么装
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
let chromium;
try {
  ({ chromium } = await import(PW));
} catch {
  console.error(
    '没找到 Playwright。这个脚本要拉一个真浏览器起来点按钮，先装一下：\n' +
    '  npm i -g playwright && npx playwright install chromium\n' +
    '或者设 PLAYWRIGHT_PATH 指向已经装好的那份 index.mjs。'
  );
  process.exit(2);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-uirun-'));
process.env.FUTUREDREAM_DATA_DIR = SANDBOX;

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const BIBLE = {
  style: { anchor: '国风水墨', palette: '青灰', negative: '模糊' },
  characters: [{ name: '阿澜', appearance: '短发，藏青立领制服', role: '巡查员', sheetPrompt: '' }],
  scenes: [{ name: '码头', appearance: '晨雾未散的老渔港', sheetPrompt: '' }],
  props: []
};
const SHOTS = {
  logline: '一次清晨的例行巡查',
  shots: [
    { index: 1, scene: '码头', characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景', motion: '缓推', dialogue: '设备正常。', speaker: '阿澜', duration: 4 },
    { index: 2, scene: '码头', characters: ['阿澜'], description: '阿澜蹲下查看缆绳', camera: '特写', motion: '固定', dialogue: '', speaker: '', duration: 3 }
  ]
};

const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.endsWith('/pixel.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PIXEL);
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (u.pathname === '/v3/chat/completions') {
      const system = JSON.stringify(body.messages?.[0]?.content || '');
      const content = system.includes('美术总监') ? JSON.stringify(BIBLE)
        : system.includes('分镜导演') ? JSON.stringify(SHOTS)
        : '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    if (u.pathname === '/v3/images/generations') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ url: `${stubUrl}/pixel.png` }] }));
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v3`;

const settings = await import('/home/user/-/desktop/core/settings.js');
const vault = await import('/home/user/-/desktop/core/vault.js');
const store = await import('/home/user/-/desktop/core/store.js');
const { listen } = await import('/home/user/-/desktop/core/server.js');

vault.setSecret('ARK_API_KEY', 'stub-key');
settings.patch({
  baseUrls: { volcengine: stubUrl },
  chatProvider: 'volcengine', chatModel: 'doubao-1-5-pro-32k-250115',
  imageProvider: 'volcengine', imageModel: 'doubao-seedream-3-0-t2i-250415',
  consistencyVerify: false,
  autoCheckOnStart: false
});

const { url } = await listen(0);
const proj = store.create({
  title: 'UI 全流程',
  aspectRatio: '9:16',
  script: '阿澜在码头巡查，发现缆绳被割断。'
});

let bad = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✕\x1b[0m'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) bad += 1;
};

const b = await chromium.launch();
const page = await b.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
console.log(`界面走查：${url}（上游全部打桩，不联外网）`);
await page.goto(`${url}#/studio/${proj.id}`);
await page.waitForTimeout(1500);

const step = (name) => page.locator('.nav-step', { hasText: name }).first();
const inner = () => page.locator('#view-inner').innerText();

// ── 第 02 步：设定集 ──
await step('设定集').click();
await page.waitForTimeout(600);
const beforeBible = await inner();
console.log('\n设定集这一步');
check('跑之前是空的', !/阿澜/.test(beforeBible));

await page.locator('.stage-detail button:has-text("开始")').first().click();
await page.waitForFunction(() => !document.querySelector('.spin'), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
const afterBible = await inner();
check('跑完角色出现在页面上（不用手动刷新）', /阿澜/.test(afterBible), afterBible.slice(0, 120));
check('设定图挂上了', (await page.locator('#view-inner img').count()) > 0);
check('左边菜单打上了对勾',
  (await page.locator('.nav-step', { hasText: '设定集' }).first().innerText()).includes('✓'));

// ── 第 03 步：分镜 ──
await step('分镜').click();
await page.waitForTimeout(600);
check('没有失败项', !(await page.locator('.fail-box').count()),
  await page.evaluate(() => document.querySelector('.fail-box')?.innerText.replace(/\n/g, ' ').slice(0, 160) || ''));

console.log('\n分镜这一步');
check('跑之前是空的', /还没有分镜/.test(await inner()));
await page.locator('.stage-detail button:has-text("开始")').first().click();
await page.waitForFunction(() => !document.querySelector('.spin'), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
const afterShots = await inner();
check('跑完分镜出现在页面上（不用手动刷新）', /阿澜走向栈桥/.test(afterShots), afterShots.slice(0, 120));
check('卡片数对得上', (await page.locator('.shot-card').count()) === SHOTS.shots.length,
  String(await page.locator('.shot-card').count()));
check('左边菜单打上了对勾',
  (await page.locator('.nav-step', { hasText: '分镜' }).first().innerText()).includes('✓'));

const hud = await page.evaluate(() => {
  const el = document.querySelector('#job-hud');
  return el && !el.hidden ? el.innerText.replace(/\n/g, ' ') : '';
});
// 右下角只在出结果时冒一次，而且要报出真实产出 —— "0 项完成"等于说白跑了
check('右下角报了结果，且数字不是 0', /分镜完成/.test(hud) && !/\b0 /.test(hud), hud);

check('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(bad ? `\n\x1b[31m${bad} 项没过\x1b[0m` : '\n\x1b[32m界面走查全过\x1b[0m');
process.exit(bad ? 1 : 0);
