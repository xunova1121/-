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
  const mod = await import(PW);
  // 全局装的那份是 CommonJS，`import` 进来时命名导出认不出来，全在 default 上
  chromium = mod.chromium || mod.default?.chromium;
  if (!chromium) throw new Error('这份 Playwright 里没有 chromium');
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

/**
 * 允许指定浏览器可执行文件。
 *
 * Playwright 用**它自己那个版本号**去找浏览器（chromium-1234/…）。
 * 机器上预装的常常是另一个版本号，于是它报"浏览器没装，请 npx playwright install"——
 * 而浏览器明明就在那儿。在没有外网、或者不想再下 150MB 的环境里，
 * 这一行是唯一能把走查跑起来的办法。
 */
const b = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
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

/**
 * ── 预演台 ──
 *
 * 这块是**拖出来**的：单元测试能验几何算得对不对，验不了
 * "手指按下去、拖过去，那个圆点跟不跟着走"。而拖动最容易坏的地方
 * 恰恰在显示尺寸和 viewBox 不一致的换算上 —— 那种错只有真拖一次才看得见。
 */
console.log('\n预演台');
/**
 * 入口要在**卡片上**看得见。
 *
 * 原来它只是编辑面板底部的一个折叠块 —— 要先点开编辑、再往下翻过
 * 描述/台词/景别/时长/场次/档位/技法一大串。用户的原话是"没找到预演台"。
 * 功能找不到等于没做，而这种漏法比崩溃更隐蔽：功能在、测试绿、没人用得上。
 *
 * 所以这里从**卡片上那个按钮**点起，不再自己去点描述展开编辑面板 ——
 * 走用户真正会走的那条路。
 */
const stageEntry = page.locator('.shot-edit-btn', { hasText: '预演台' }).first();
check('卡片上直接看得到预演台入口', (await stageEntry.count()) > 0);
await stageEntry.click();
await page.waitForTimeout(600);
const previz = page.locator('.shot-previz').first();
check('点一下就展开了（不用再自己去翻）',
  (await previz.count()) > 0 && (await previz.evaluate((n) => n.open)) === true);
if (await previz.count()) {
  const canvas = page.locator('.previz-canvas').first();
  check('画布画出来了', await canvas.count() > 0);
  const before = await page.locator('.previz-line-text').first().innerText().catch(() => '');
  check('读数一开始就有（不是拖了才出现）', /mm/.test(before), before.slice(0, 60));

  /**
   * 真的拖一次机位：从机位圆点拖到画布右上角。
   *
   * ⚠ 必须先滚进视口再量坐标。boundingBox() 给的是**页面**坐标（含滚动），
   * 而 page.mouse 用的是**视口**坐标 —— 元素在折线以下时，两者差一个滚动量，
   * 鼠标会按下在完全不相干的地方。第一版就栽在这儿：面板在 y≈744，
   * 而视口只有 720 高，于是"拖了但没反应"，看起来像功能坏了。
   */
  const cam = page.locator('.previz-cam').first();
  await cam.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await cam.boundingBox();
  const cbox = await canvas.boundingBox();
  const vp = page.viewportSize();
  check('机位圆点在视口里（不然鼠标会按在别处，测了个寂寞）',
    Boolean(box) && box.y >= 0 && box.y + box.height <= vp.height,
    `box.y=${box?.y?.toFixed(0)} 视口高=${vp.height}`);
  if (box && cbox) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(cbox.x + cbox.width * 0.8, cbox.y + cbox.height * 0.2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  const afterDrag = await page.locator('.previz-line-text').first().innerText().catch(() => '');
  check('拖动机位之后读数跟着变了', afterDrag !== before, `${before.slice(0, 40)} → ${afterDrag.slice(0, 40)}`);
  // 拖到人后面去，看它认不认得出"现在看到的是背面"
  check('读数里说了现在看到的是哪一面',
    /正面|侧面|斜侧|侧后|背面/.test(afterDrag), afterDrag.slice(0, 80));
}


// ── 换画风之后，设定集要认出"冻结的那段话过期了" ──
// 这是真在浏览器里点：接口对了但提示没冒出来，用户照样看不见
console.log('\n换画风之后');
await page.evaluate(async (id) => {
  await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ styleId: 'guofeng' })
  });
  // 直接改设定集里那段话，模拟"预设后来被改进了"这种情况
  const p = await (await fetch(`/api/projects/${id}`)).json();
  p.bible.style.anchor = '老早以前那一段';
  await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bible: p.bible })
  });
}, proj.id);
await step('设定集').click();
await page.waitForTimeout(900);
check('提示冒出来了', (await page.locator('.notice.warn').count()) > 0);
const noticeText = await page.locator('.notice.warn').first().innerText().catch(() => '');
check('把"现在是什么、换成什么"都摆出来了',
  /老早以前那一段/.test(noticeText) && /青绿/.test(noticeText), noticeText.replace(/\n/g, ' ').slice(0, 160));

await page.locator('.notice.warn button').first().click();
await page.waitForTimeout(900);
check('点完提示消失了', (await page.locator('.notice.warn').count()) === 0);

/**
 * 只看**看得见**的输入框。
 *
 * 各步的面板都留在 DOM 里、靠 display 切换，所以 `textarea` 的第一个
 * 很可能是隐藏着的剧本框 —— 断言就会盯着一个用户根本看不到的东西。
 * 同理，角色名在 input 的 value 里，innerText 抓不到它（第一版就栽在这儿：
 * 那个"阿澜"其实是日志里的，不是角色卡上的）。
 */
const shown = () => page.locator('#view-inner textarea:visible');
const values = async () => (await shown().evaluateAll((ns) => ns.map((n) => n.value)));
const after = await values();
check('输入框里的字当场换了（不用整页重画）', /青绿/.test(after[0] || ''), (after[0] || '').slice(0, 60));
// 换一句话不该让手改过的角色描述陪葬
check('角色描述没被冲掉', after.some((v) => v.includes('藏青立领制服')), JSON.stringify(after.slice(0, 6)));

/**
 * ── 素材包缺镜要说出来 ──
 *
 * 少一镜的包看起来和齐了的一模一样：文件按序号排好、分镜表也在。
 * 人拖进剪映排完一条时间线才发现中间缺一段 —— 那时候要么回来补出、
 * 要么将就着接上，两条都是白干一遍。
 *
 * 手机端那条走查里同一件事已经验过；这一条守的是电脑端别落下。
 */
console.log('\n素材包');
await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  // 第一镜给个片段，其余留空 —— 这正是"出了一半"的常态
  const shots = (p.shots || []).map((s, i) => (i === 0 ? { ...s, videoPath: '/tmp/x.mp4' } : s));
  await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shots, outputs: { video: '/tmp/final.mp4', seconds: 7, durationPolicy: 'trim' } })
  });
}, proj.id);
await page.reload();
await page.waitForTimeout(1200);
await step('合成').click();
await page.waitForTimeout(900);
const filmText = await page.locator('#view-inner').innerText();
check('缺镜时当场点名', /还没出视频/.test(filmText), filmText.slice(0, 200));
check('并且说清楚后果（拖进剪映才发现缺一段）', /剪映/.test(filmText) && /缺一段/.test(filmText));

check('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(bad ? `\n\x1b[31m${bad} 项没过\x1b[0m` : '\n\x1b[32m界面走查全过\x1b[0m');
process.exit(bad ? 1 : 0);
