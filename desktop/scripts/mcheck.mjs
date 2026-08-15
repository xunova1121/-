/**
 * 手机端走查：开局域网监听 → 用 iPhone 的视口和 UA 打开 /m → 配对 → 翻三个页签。
 *
 *     node scripts/mcheck.mjs
 *
 * 和 uicheck.mjs 一样需要本机装了 Playwright，CI 不跑（打包机装浏览器不值当）。
 * 上游不联网 —— 这一段验的是**规矩和界面**，不是模型能不能出图。
 *
 * 重点验的是"它拒绝什么"：这条口子后面挂着 API 密钥和额度，
 * 同一个 Wi-Fi 下的人不该随手就能驱动它。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
let chromium; let devices;
try {
  ({ chromium, devices } = await import(PW));
} catch {
  console.error(
    '没找到 Playwright。先装一下：npm i -g playwright && npx playwright install chromium\n' +
    '或者设 PLAYWRIGHT_PATH 指向已经装好的那份 index.mjs。'
  );
  process.exit(2);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-m-'));
process.env.FUTUREDREAM_DATA_DIR = SANDBOX;

const settings = await import('/home/user/-/desktop/core/settings.js');
const store = await import('/home/user/-/desktop/core/store.js');
const srv = await import('/home/user/-/desktop/core/server.js');

settings.patch({ autoCheckOnStart: false });
const proj = store.create({ title: '手机端测试', aspectRatio: '9:16', script: '阿澜在码头巡查。' });
store.update(proj.id, (p) => {
  p.bible = { style: { anchor: '国风', negative: '' },
    characters: [{ name: '阿澜', appearance: '短发', seed: 1, variants: [{ id: 'v-default', name: '默认造型', sheetPath: 'x.png' }], sheetPath: 'x.png' }],
    scenes: [], props: [] };
  p.shots = [
    { id: 's1', index: 1, characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景', dialogue: '设备正常。', speaker: '阿澜', duration: 4, consistency: { score: 88, pass: true } },
    { id: 's2', index: 2, characters: ['阿澜'], description: '阿澜蹲下查看缆绳', camera: '特写', dialogue: '', duration: 3 }
  ];
  p.stageStatus = { ...p.stageStatus, bible: 'done', script: 'done' };
  return p;
});

const lan = await srv.startLan();
console.log('局域网监听：', JSON.stringify({ running: lan.running, port: lan.port, urls: lan.urls }));
const token = settings.get('lanToken');
const base = `http://127.0.0.1:${lan.port}`;

// 先验规矩：没有配对码时，数据一律不给
const noKey = await fetch(`${base}/api/projects`);
console.log('没配对码取数据：', noKey.status, noKey.status === 401 ? '✓ 挡住了' : '✕ 放行了（严重）');
const shell = await fetch(`${base}/m`);
console.log('页面本身放行（不然只看到 401 不知道干什么）：', shell.status === 200 ? '✓' : `✕ ${shell.status}`);
const withKey = await fetch(`${base}/api/projects`, { headers: { 'X-FD-Key': token } });
console.log('带配对码：', withKey.status === 200 ? '✓ 通了' : `✕ ${withKey.status}`);
const wrongKey = await fetch(`${base}/api/projects`, { headers: { 'X-FD-Key': 'WRONGKEY' } });
console.log('错的配对码：', wrongKey.status === 401 ? '✓ 挡住了' : `✕ ${wrongKey.status}`);

const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

// ① 不带码打开 → 应该看到配对屏
await page.goto(`${base}/m`);
await page.waitForTimeout(1200);
console.log('\n① 不带码打开：', /配对码/.test(await page.locator('#app').innerText()) ? '显示配对屏 ✓' : '✕');

// ② 敲错的码
await page.locator('input').fill('WRONGKEY');
await page.locator('button:has-text("连接")').click();
await page.waitForTimeout(900);
console.log('② 敲错的码：', /配对码不对/.test(await page.locator('body').innerText()) ? '当场说清楚 ✓' : '✕');

// ③ 带码的链接（电脑上「复制」给的就是这个）
await page.goto(`${base}/m?k=${token}`);
await page.waitForTimeout(1500);
const txt = await page.locator('#app').innerText();
console.log('③ 带码链接直接进：', /手机端测试/.test(txt) ? '进去了 ✓' : `✕ ${txt.slice(0, 80)}`);
console.log('   地址栏里的码抹掉了吗：', page.url().includes('k=') ? '✕ 还留着' : '✓ 抹掉了');
console.log('   流水线：', (await page.locator('.step').allInnerTexts()).map((t) => t.replace(/\n/g, ' ')).join(' | '));

// ④ 分镜
await page.locator('.tab', { hasText: '分镜' }).click();
await page.waitForTimeout(700);
const shots = await page.locator('.shot').count();
console.log('④ 分镜卡片数：', shots, shots === 2 ? '✓' : '✕');
console.log('   台词和说话人：', /阿澜：「设备正常。」/.test(await page.locator('#app').innerText()) ? '✓' : '✕');

// ⑤ 成片
await page.locator('.tab', { hasText: '成片' }).click();
await page.waitForTimeout(500);
console.log('⑤ 还没成片时：', /还没有成片/.test(await page.locator('#app').innerText()) ? '说清楚了 ✓' : '✕');

// ⑥ PWA 三件套
const man = await fetch(`${base}/m/manifest.webmanifest`);
const sw = await fetch(`${base}/m/sw.js`);
const icon = await fetch(`${base}/m/icon-192.png`);
console.log('⑥ manifest / sw / icon：', [man.status, sw.status, icon.status].join(' '),
  man.status === 200 && sw.status === 200 && icon.status === 200 ? '✓' : '✕');

// ⑦ 触控目标够不够大（拇指按不中的按钮等于没有）
const small = await page.evaluate(() =>
  [...document.querySelectorAll('button, .tab, a.btn')]
    .map((el) => ({ t: el.innerText.trim().slice(0, 8), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h > 0 && x.h < 36));
console.log('⑦ 小于 36px 的可点元素：', small.length ? JSON.stringify(small) : '没有 ✓');

console.log('\n页面报错：', errs.length ? errs.slice(0, 4) : '无');
await b.close();
srv.stopLan();
process.exit(0);
