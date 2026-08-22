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

/**
 * 成片体检要在这一页上**真的画出来**。
 *
 * 它是个异步拉取 —— 接口对了但界面没渲染，用户照样看不到，
 * 而这正是这个项目里反复出现的那种漏法。所以在真浏览器里读一次。
 */
await page.waitForTimeout(900);
const q = await page.locator('#view-inner').innerText();
check('成片页上有体检结论', /成片体检/.test(q), q.slice(0, 160));
// 光一个分数没有信息量 —— 人下一秒就要问"哪儿扣的分"
check('不是只印一个分数，条目摊开了',
  /会被看出来|质量风险|四类检查都过了/.test(q), q.slice(0, 300));
check('并且说清楚后果（拖进剪映才发现缺一段）', /剪映/.test(filmText) && /缺一段/.test(filmText));

/**
 * 首尾帧要**默认就是开着的**，而且在设置界面上看起来也得是开着的。
 *
 * 引擎那边的默认值早就是 lock 了，但这个下拉框里还留着一句
 * `settings.seamMode || 'tail'` —— 真有人把设置清干净的时候，
 * 界面会显示「接住真实末帧」而引擎跑的是首尾帧。
 * 一个显示错的开关比没有开关更糟：人照着它做判断，然后判断全是错的。
 *
 * 所以这一条在**真浏览器里读那个 select 的值**，不读源码。
 */
await page.locator('.nav-item:has-text("设置")').first().click();
await page.waitForTimeout(900);

/**
 * 「合成」那一整块原来一个控件都没有 —— 时长策略、自动剪辑、音效音量
 * 三样只活在默认值里，谁都改不了。而它们恰恰决定了成片好不好看。
 *
 * 加了功能却不给入口，和没加是一样的；更糟的是**我以为加了**，
 * 还让用户去「设置 → 音效音量」找一个不存在的地方。
 */
{
  const body = await page.locator('#view-inner').innerText();
  check('设置里有「合成」这一块', /合成/.test(body) && /时长策略/.test(body), body.slice(0, 200));
  const durSel = page.locator('select').filter({ has: page.locator('option[value="keep"]') }).first();
  check('时长策略选得到', (await durSel.count()) === 1);
  if ((await durSel.count()) === 1) {
    check('默认选中的是「保留完整片段」',
      (await durSel.inputValue()) === 'keep', await durSel.inputValue());
  }
  check('音效音量填得了', /音效音量/.test(body), body.slice(0, 400));
  // 这三样的共同点：改完只要重新合成，不用重新生成 —— 这句话必须写出来
  check('说清楚改完不用重新生成', /不用重新生成任何镜头|不花钱/.test(body), body.slice(0, 400));
}
const seamSel = page.locator('select').filter({ has: page.locator('option[value="lock"]') }).first();
check('设置里有接缝这一项', (await seamSel.count()) === 1);
if ((await seamSel.count()) === 1) {
  check('电脑版上默认选中的就是首尾帧',
    (await seamSel.inputValue()) === 'lock', await seamSel.inputValue());
  const opt = await seamSel.locator('option[value="lock"]').innerText();
  check('并且写清楚它是什么（本镜首帧 + 下一镜末帧）',
    /首尾帧/.test(opt) && /下一镜/.test(opt), opt.slice(0, 80));
}

/**
 * ── 剪辑台 ──
 *
 * 成片出来之后还能改顺序、设入出点、跳过某一镜，改完只重新合成 ——
 * 十几秒，一分钱不花。这块的价值全在"改了真的算数"，
 * 所以量的是**点完之后项目里存下了什么**，不是"有没有这个面板"。
 */
console.log('\n剪辑台');
await page.evaluate(async (id) => {
  // 造三段有视频的镜头，让剪辑台有东西可排（上游打桩，不出真视频）。
  // 三段而不是两段：两段的话"往后挪一位"和"拖到最后"是同一个结果，分不出来
  const p = await (await fetch(`/api/projects/${id}`)).json();
  const shots = (p.shots || []).map((s, i) => ({
    ...s, videoPath: `/tmp/fake-${i}.mp4`, actualDuration: 5, duration: 4
  }));
  while (shots.length < 3) {
    shots.push({
      ...shots[0],
      id: `extra-${shots.length}`,
      index: shots.length + 1,
      description: `补的第 ${shots.length + 1} 镜`,
      videoPath: `/tmp/fake-${shots.length}.mp4`
    });
  }
  await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shots, outputs: { video: '/tmp/final.mp4', seconds: 9 } })
  });
}, proj.id);
await page.goto(`${url}#/studio/${proj.id}`);
await page.waitForTimeout(1800);
await step('合成').click();
await page.waitForTimeout(1200);

const readEdit = () => page.evaluate(
  (id) => fetch(`/api/projects/${id}`).then((r) => r.json()).then((p) => p.edit || {}), proj.id);

const cutRows = page.locator('.cut-row');
check('剪辑台把每一镜列出来了', (await cutRows.count()) === 3, String(await cutRows.count()));
if ((await cutRows.count()) === 3) {
  const idsNow = async () => (await readEdit()).order || [];

  /**
   * ── 拖拽排序 ──
   *
   * 这是这一版最容易"看着能用、其实没存"的一处：拖动是纯前端的动作，
   * 松手之后如果没把新顺序发出去，界面上排得好好的，刷新一下全变回去。
   * 所以量的是**盘上存的顺序**，不是屏幕上的位置。
   */
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.cut-row')].map((r) => r.dataset.shot));
  /**
   * ⚠ 拖拽要用 page.mouse，而它吃的是**视口坐标**，不是页面坐标。
   *
   * .click() 会自己把元素滚进视口，mouse.move 不会 —— 元素在折线以下时，
   * 鼠标落在视口外面，什么都点不到，而**一条报错都没有**：
   * 落点线没出现、顺序没变，看起来就像"拖拽功能没做"。
   * 走查第一版就是这么红的，而产品代码是好的。
   * 所以这里先把视口拉高、再把那一行滚进来，两件都做。
   */
  const grip = cutRows.first().locator('.cut-grip');
  await page.setViewportSize({ width: 1280, height: 1400 });
  await grip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const g = await grip.boundingBox();
  const last = await cutRows.nth(2).boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, last.y + last.height - 3, { steps: 10 });
  check('拖动时有一条落点线，能看出会插到哪儿',
    (await page.locator('.cut-marker').count()) === 1, String(await page.locator('.cut-marker').count()));
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dragged = await idsNow();
  check('拖拽排序真的存下来了（第一镜被拖到了最后）',
    dragged[dragged.length - 1] === before[0], `${JSON.stringify(dragged)} ← 原 ${JSON.stringify(before)}`);
  check('拖完落点线收干净了', (await page.locator('.cut-marker').count()) === 0);

  /**
   * ⚠ 再拖一次，这次落在**中间**。
   *
   * 只测"拖到最后"是不够的：那个位置上，"自己被拿走之后后面都往前挪一位"
   * 这条修正错不错，结果都一样（都是追加到末尾）。走查里试过 ——
   * 把那行修正删掉，第一条断言纹丝不动地绿着。
   * 往下拖到中间才分得出来：算错一位的话这一镜会越过目标多走一格。
   */
  const g2 = await cutRows.first().locator('.cut-grip').boundingBox();
  const mid = await cutRows.nth(1).boundingBox();
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  await page.mouse.move(g2.x + g2.width / 2, mid.y + mid.height - 3, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const mid2 = await idsNow();
  check('往下拖到中间时落点不多走一格',
    mid2[1] === dragged[0] && mid2[0] === dragged[1],
    `${JSON.stringify(mid2)} ← ${JSON.stringify(dragged)}`);

  // ↑↓ 也还在：拖拽不精确的时候要有一条稳的路
  await cutRows.first().locator('button:has-text("↓")').click();
  await page.waitForTimeout(700);
  const afterMove = await idsNow();
  check('↑↓ 挪一位也照样存下来',
    afterMove[0] !== mid2[0], `${JSON.stringify(afterMove)} ← ${JSON.stringify(mid2)}`);

  /**
   * ── 裁剪条 ──
   *
   * 两个数字框谁都会做，但没人能拿着两个数字想象出这一刀切在哪儿。
   * 拖把手是这块能不能叫"剪辑台"的分界，而它必须真的写进 edit。
   */
  const bar = cutRows.first().locator('.cut-bar');
  const bb = await bar.boundingBox();
  const handle = cutRows.first().locator('.cut-handle.a');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.4, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const afterDrag = await readEdit();
  const dragIn = Object.values(afterDrag.clips || {}).map((c) => c.in).find((v) => v > 0);
  check('拖裁剪条真的设上了入点', dragIn > 0.5 && dragIn < 4, JSON.stringify(afterDrag.clips));
  check('拖完那一行的读数跟着变了',
    /→/.test(await cutRows.first().locator('.cut-bar-txt').innerText()),
    await cutRows.first().locator('.cut-bar-txt').innerText());

  // 数字框那条路也要还在（拖不准的时候手填）
  const inBox = cutRows.nth(1).locator('input[type=number]').first();
  await inBox.fill('1.5');
  await inBox.dispatchEvent('change');
  await page.waitForTimeout(700);
  const afterIn = await readEdit();
  check('手填入点也真的存下来了',
    Object.values(afterIn.clips || {}).some((c) => c.in === 1.5), JSON.stringify(afterIn.clips));

  // ── 转场：改的是剪辑决定，不是分镜字段 ──
  const transSel = cutRows.nth(1).locator('select').first();
  await transSel.selectOption('slideleft');
  await page.waitForTimeout(700);
  const afterTrans = await readEdit();
  check('换转场存进了剪辑决定（不冲掉分镜里那个建议值）',
    Object.values(afterTrans.clips || {}).some((c) => c.trans === 'slideleft'),
    JSON.stringify(afterTrans.clips));
  check('第一段的转场是灰的（它前面没有片子，没有"怎么接上来"这回事）',
    await cutRows.first().locator('select').first().isDisabled());
  const transOpts = await transSel.locator('option').count();
  check(`转场不止那三个（现在有 ${transOpts} 种）`, transOpts >= 15, String(transOpts));

  // ── 画面效果 ──
  const fxSel = cutRows.nth(1).locator('select').nth(1);
  await fxSel.selectOption('bw');
  await page.waitForTimeout(700);
  const afterFx = await readEdit();
  check('画面效果存下来了',
    Object.values(afterFx.clips || {}).some((c) => c.fx === 'bw'), JSON.stringify(afterFx.clips));

  // ── 单镜静音 ──
  await cutRows.nth(1).locator('button[title*="不要声音"]').click();
  await page.waitForTimeout(700);
  const afterMute = await readEdit();
  check('单镜静音存下来了',
    Object.values(afterMute.clips || {}).some((c) => c.mute === true), JSON.stringify(afterMute.clips));

  // ── 跳过一镜 ──
  await page.locator('.cut-row button:has-text("不用")').first().click();
  await page.waitForTimeout(700);
  const afterOff = await readEdit();
  check('"不用"真的存下来了',
    Object.values(afterOff.clips || {}).some((c) => c.off === true), JSON.stringify(afterOff.clips));

  /**
   * ── 音轨开关 ──
   *
   * 声音的问题是整片性的（"音效太吵""音乐盖住台词"从来不是某一镜的事），
   * 所以开关摆在片段上面。关掉不删任何文件 —— 这一点界面上必须说出来。
   */
  const voiceBtn = page.locator('.cut-track button[title*="不混任何配音"]');
  await voiceBtn.click();
  await page.waitForTimeout(700);
  const afterTrack = await readEdit();
  check('关掉台词轨真的存下来了', afterTrack.tracks?.voice === false, JSON.stringify(afterTrack.tracks));
  await voiceBtn.click();
  await page.waitForTimeout(700);
  check('再点一下就开回来（只存"被关掉"的那些）',
    (await readEdit()).tracks?.voice === undefined, JSON.stringify((await readEdit()).tracks));

  /**
   * ── 背景音乐 ──
   *
   * 传上去只是存文件；混音发生在合成那一步。所以这里量的是
   * "文件到了没、参数记上没"，真正的混音由 realcheck 拿真 FFmpeg 验。
   */
  const musicInput = page.locator('.cut-audio input[type=file]');
  await musicInput.setInputFiles({
    name: '走查用.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('ID3      fake-mp3-body', 'binary')
  });
  await page.waitForTimeout(1500);
  const afterMusic = await readEdit();
  check('背景音乐传上去了，路径记在项目里', Boolean(afterMusic.music?.path), JSON.stringify(afterMusic.music));
  check('音乐的默认参数是"压在台词底下 + 自动避让"',
    afterMusic.music?.gain <= 0.3 && afterMusic.music?.duck !== false, JSON.stringify(afterMusic.music));
  check('传完之后音量、避让、淡入淡出这些控件出来了',
    (await page.locator('.cut-track input[type=range]').count()) >= 2,
    String(await page.locator('.cut-track input[type=range]').count()));
  check('说清楚曲子的授权要自己确认',
    /授权/.test(await page.locator('.cut-audio').innerText()), '');

  const duckBox = page.locator('.cut-track label[title*="自动让开"] input[type=checkbox]');
  if (await duckBox.count()) {
    await duckBox.uncheck();
    await page.waitForTimeout(700);
    check('关掉自动避让也存得下来', (await readEdit()).music?.duck === false,
      JSON.stringify((await readEdit()).music));
  }

  await page.locator('button:has-text("移除")').click();
  await page.waitForTimeout(800);
  check('撤下音乐之后项目里就没有了', !(await readEdit()).music, JSON.stringify((await readEdit()).music));

  // ── 恢复默认：只清片段那一块，音轨开关不该被顺手清掉 ──
  await page.locator('button:has-text("恢复默认")').click();
  await page.waitForTimeout(900);
  const afterReset = await readEdit();
  check('「恢复默认」把剪辑决定清干净',
    Object.keys(afterReset.clips || {}).length === 0, JSON.stringify(afterReset));
  const shotIds = await page.evaluate((id) =>
    fetch(`/api/projects/${id}`).then((r) => r.json()).then((p) => p.shots.map((s) => s.id)), proj.id);
  check('并且顺序回到按镜号排',
    (afterReset.order || [])[0] === shotIds[0], JSON.stringify(afterReset.order));
}
check('说清楚重新合成不花钱',
  /一分钱不花|不花钱/.test(await page.locator('#view-inner').innerText()), '');
check('画面效果那一栏如实说了"慢一点但不花钱"',
  /不花钱/.test(await page.locator('.cut-row select').nth(1).getAttribute('title') || ''),
  await page.locator('.cut-row select').nth(1).getAttribute('title'));

check('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(bad ? `\n\x1b[31m${bad} 项没过\x1b[0m` : '\n\x1b[32m界面走查全过\x1b[0m');
process.exit(bad ? 1 : 0);
