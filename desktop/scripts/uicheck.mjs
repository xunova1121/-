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
/**
 * 记下发出去的每一条请求。
 *
 * 「重新合成」这颗按钮从来没被点过（点了会真去合成），于是它调了一个
 * **这个文件里根本不存在的函数**这件事，一直没人发现 —— 用户报上来的原话是
 * "重新合成这个按钮按不动"。量"有没有真的发出那一次请求"，就再也漏不掉了。
 */
const sent = [];
page.on('request', (r) => sent.push(`${r.method()} ${new URL(r.url()).pathname}`));
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

  /**
   * ── 场景的东南西北 ──
   *
   * 上面那句"机位在人物右前方"是相对**人**的，人一转身就指向房间里别处。
   * 相对**房间**的那句（"机位在场景西南侧、朝东北拍"）才是同一场戏里
   * 每一镜都对得上的话 —— 而它得先在图上有个基准才读得懂。
   */
  check('画布上标了东南西北', (await page.locator('.previz-compass').count()) === 4,
    String(await page.locator('.previz-compass').count()));
  const chips = await page.locator('.previz-chips').first().innerText().catch(() => '');
  check('读数里有"机位在场景哪一侧、朝哪儿拍"',
    /场景[东南西北]+侧/.test(chips) && /朝[东南西北]+拍/.test(chips), chips.slice(0, 120));

  /**
   * 摆一个地标上去 —— 观众判断"人在房间里的哪儿"靠的就是这些不动的东西。
   * 摆上之后必须能当场算出它在画面的哪一边。
   */
  const markBtn = page.locator('.previz-row button', { hasText: '窗' }).first();
  if (await markBtn.count()) {
    await markBtn.click();
    await page.waitForTimeout(400);
    check('点一下就把地标摆到图上', (await page.locator('.previz-mark').count()) >= 1,
      String(await page.locator('.previz-mark').count()));
    const withMark = await page.locator('.previz-chips').first().innerText().catch(() => '');
    check('并且当场算出它在画面哪一边（或者出画了）',
      /窗：(画面左|画面右|正中|画外)/.test(withMark), withMark.slice(0, 160));
    // 再点一下收回去 —— 摆错了要能撤
    await page.locator('.previz-row button', { hasText: '窗' }).first().click();
    await page.waitForTimeout(300);
    check('再点一下能把它撤掉', (await page.locator('.previz-mark').count()) === 0,
      String(await page.locator('.previz-mark').count()));
  }

  /**
   * ── 外景 ──
   *
   * 外景没有门窗桌椅。钉住空间的是**远处那几样**（山、塔、海）和**光**，
   * 而它们和近处地标在数学上完全不同：只有方位、没有坐标 ——
   * 机位挪三米，一座山在画面里纹丝不动。所以它们摆在画布边上。
   */
  /**
   * ⚠ 全都摆上，不要只摆一个。
   *
   * 只摆一个的话，它落在镜头背后（前面拖过机位，轴向早不是初始那个了）
   * 就完全读不到 —— 而那是走查站错了地方，不是功能没做。
   * 五个方位铺开，总有一个在画面里。
   */
  const farNames = ['山', '塔', '海', '天际线', '路口'];
  let farClicked = 0;
  for (const name of farNames) {
    const b = page.locator('.previz-row button', { hasText: name }).first();
    if (!(await b.count())) continue;
    await b.click();
    await page.waitForTimeout(150);
    farClicked += 1;
  }
  if (farClicked) {
    await page.waitForTimeout(300);
    check(`远景地标摆在画布边上（它只有方位，没有坐标）—— 摆了 ${farClicked} 个`,
      (await page.locator('.previz-far').count()) === farClicked,
      String(await page.locator('.previz-far').count()));
    const farChips = await page.locator('.previz-chips').first().innerText().catch(() => '');
    check('读数里标出它是"远"的（不标的话模型会把山画成近景里一块石头）',
      /（远）/.test(farChips), farChips.slice(0, 160));
  }

  const sunBtn = page.locator('.previz-row button', { hasText: '加太阳' }).first();
  if (await sunBtn.count()) {
    await sunBtn.click();
    await page.waitForTimeout(400);
    check('太阳摆上去了', (await page.locator('.previz-sun').count()) === 1,
      String(await page.locator('.previz-sun').count()));
    const lit = await page.locator('.previz-chips').first().innerText().catch(() => '');
    /**
     * 光是外景最要紧的一样：上一镜逆光、这一镜顺光，观众读出来是
     * "这两镜不是同一时间拍的"。而模型不知道太阳在哪 —— 除非每一镜都说。
     */
    check('读数里当场算出是顺光还是逆光',
      /顺光|逆光|侧光|侧逆光/.test(lit), lit.slice(0, 180));
    check('高度那三档也点得到',
      (await page.locator('.previz-row button', { hasText: '正午顶光' }).count()) >= 1);
  }
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
 * ── 剪辑台（时间线）──
 *
 * 成片出来之后还能改顺序、裁一刀、换转场、配乐，改完只重新合成 ——
 * 十几秒，一分钱不花。
 *
 * 这块的价值全在"改了真的算数"，所以量的是**操作完项目里存下了什么**，
 * 不是"有没有这个面板"。另外有两条是专门盯着"时间线"这个形态的：
 * 片段宽度要和时长成比例、裁短之后要真的变窄 —— 一律等宽的话
 * 它就退化成一张带缩略图的清单了，而"哪一段特别长"正是人打开它要问的第一个问题。
 */
console.log('\n剪辑台（时间线）');
await page.evaluate(async (id) => {
  // 造三段有视频的镜头，让时间线有东西可排（上游打桩，不出真视频）。
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
await page.setViewportSize({ width: 1400, height: 1500 });
await page.goto(`${url}#/studio/${proj.id}`);
await page.waitForTimeout(1800);
await step('合成').click();
await page.waitForTimeout(1200);

const readEdit = () => page.evaluate(
  (id) => fetch(`/api/projects/${id}`).then((r) => r.json()).then((p) => p.edit || {}), proj.id);
const idsNow = async () => (await readEdit()).order || [];

/**
 * ⚠ 剪辑台要在**「成片」上面**，而且是独立一块。
 *
 * 人的动作是"先剪，再出片，再看" —— 摆在成片下面等于让人先看完片子
 * 再往回翻去改。它原来还整个藏在"已经有成片"的分支里，
 * 可第一次合成之前恰恰最该先排一遍顺序。
 */
check('剪辑台是独立一块，排在「成片」上面', await page.evaluate(() => {
  const all = [...document.querySelectorAll('.panel')].filter((p) => p.offsetParent !== null);
  const cut = all.findIndex((p) => /剪辑台/.test(p.querySelector('.panel-title')?.textContent || ''));
  const film = all.findIndex((p) => /^成片$/.test(p.querySelector('.panel-title')?.textContent || ''));
  return cut >= 0 && film >= 0 && cut < film;
}), '');

const tlClips = page.locator('.tl-clip');
check('时间线把每一镜摆成了一段', (await tlClips.count()) === 3, String(await tlClips.count()));

/**
 * ⚠ 这是"时间线"和"清单"的分界：宽度必须**和时长成比例**。
 *
 * 一律等宽的话，"哪一段特别长"这件事就看不出来了 —— 而那正是
 * 人打开剪辑台要回答的第一个问题。所以把一段裁短之后，它的像素宽度必须跟着变。
 */
const widthOf = (i) => page.evaluate(
  (n) => document.querySelectorAll('.tl-clip')[n].getBoundingClientRect().width, i);
const w0 = await widthOf(0);
check('片段有宽度（时间线真的画出来了）', w0 > 20, String(w0));

if ((await tlClips.count()) === 3) {
  /**
   * ── 拖着换位置 ──
   *
   * 这是最容易"看着能用、其实没存"的一处：拖动是纯前端的动作，
   * 松手之后如果没把新顺序发出去，屏幕上排得好好的，刷新一下全变回去。
   * 所以量的是**盘上存的顺序**，不是屏幕上的位置。
   */
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.tl-clip')].map((c) => c.dataset.shot));
  const b0 = await tlClips.first().boundingBox();
  const b2 = await tlClips.nth(2).boundingBox();
  // 从第一段的中间按下（避开两端 8px 的裁剪把手），拖到最后一段的右半边
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width - 6, b0.y + b0.height / 2, { steps: 12 });
  check('拖动时有一条落点线，能看出会插到哪儿',
    await page.locator('.tl-drop').isVisible(), '');
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dragged = await idsNow();
  check('拖拽换位置真的存下来了（第一段被拖到了最后）',
    dragged[dragged.length - 1] === before[0], `${JSON.stringify(dragged)} ← 原 ${JSON.stringify(before)}`);

  /**
   * ⚠ 再拖一次，这次落在**中间**。
   *
   * 只测"拖到最后"是不够的：那个位置上，"自己被拿走之后后面都往前挪一位"
   * 这条修正错不错，结果都一样（都是追加到末尾）。往下拖到中间才分得出来。
   */
  const c0 = await tlClips.first().boundingBox();
  const c1 = await tlClips.nth(1).boundingBox();
  await page.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2);
  await page.mouse.down();
  await page.mouse.move(c1.x + c1.width - 6, c0.y + c0.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const mid2 = await idsNow();
  check('往下拖到中间时落点不多走一格',
    mid2[1] === dragged[0] && mid2[0] === dragged[1],
    `${JSON.stringify(mid2)} ← ${JSON.stringify(dragged)}`);

  /**
   * ── 拖两端裁剪 ──
   *
   * 数字框谁都会做，但没人能拿着两个数字想象出这一刀切在哪儿。
   * 拖边缘是这块能不能叫"剪辑台"的分界，而它必须真的写进 edit，
   * 并且**这一段在时间线上要跟着变窄**。
   */
  const target = tlClips.first();
  const tb = await target.boundingBox();
  const wBefore = tb.width;
  await page.mouse.move(tb.x + 3, tb.y + tb.height / 2);   // 左边缘 = 入点把手
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width * 0.4, tb.y + tb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const afterTrim = await readEdit();
  const cutIn = Object.values(afterTrim.clips || {}).map((c) => c.in).find((v) => v > 0);
  check('拖左边缘真的设上了入点', cutIn > 0.3, JSON.stringify(afterTrim.clips));
  const wAfter = await widthOf(0);
  check(`裁短之后这一段在时间线上变窄了（${wBefore.toFixed(0)}px → ${wAfter.toFixed(0)}px）`,
    wAfter < wBefore - 8, `${wBefore} → ${wAfter}`);

  // ── 属性面板 ──
  check('选中之后右边属性面板显示的是它',
    /第 \d+ 镜/.test(await page.locator('.tl-props').innerText()),
    (await page.locator('.tl-props').innerText()).slice(0, 80));
  const propIn = page.locator('.tl-props input[type=number]').first();
  await propIn.fill('1.5');
  await propIn.dispatchEvent('change');
  await page.waitForTimeout(700);
  check('属性面板里手填入点也存得下来',
    Object.values((await readEdit()).clips || {}).some((c) => c.in === 1.5),
    JSON.stringify((await readEdit()).clips));

  // ── 撤销 / 重做 ──
  /**
   * 剪辑台上每一步都是破坏性的，而人一定会拖错。没有撤销的话唯一的退路是
   * 「恢复默认」—— 那会把之前调好的全清掉，代价大到人干脆不敢拖。
   */
  const beforeUndo = JSON.stringify(await readEdit());
  await page.locator('.tl-bar button:has-text("撤销")').click();
  await page.waitForTimeout(800);
  const afterUndo = JSON.stringify(await readEdit());
  check('撤销真的退回了上一步', afterUndo !== beforeUndo, afterUndo.slice(0, 120));
  await page.locator('.tl-bar button:has-text("重做")').click();
  await page.waitForTimeout(800);
  check('重做又回到了撤销之前那一步',
    JSON.stringify(await readEdit()) === beforeUndo, JSON.stringify(await readEdit()).slice(0, 120));

  // ── 转场 / 效果 / 静音（都在属性面板里）──
  // 先选中第 2 段：第一段没有"怎么接上来"这回事，它的转场框是灰的
  const secondBox = await tlClips.nth(1).boundingBox();
  await page.mouse.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.waitForTimeout(500);
  check('第一段的转场框是灰的（它前面没有片子）', await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tl-clip')];
    cards[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return document.querySelector('.tl-props select')?.disabled === true;
  }), '');
  await page.mouse.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.waitForTimeout(500);
  const transSel = page.locator('.tl-props select').first();
  await transSel.selectOption('slideleft');
  await page.waitForTimeout(700);
  check('换转场存进了剪辑决定（不冲掉分镜里那个建议值）',
    Object.values((await readEdit()).clips || {}).some((c) => c.trans === 'slideleft'),
    JSON.stringify((await readEdit()).clips));
  const transOpts = await transSel.locator('option').count();
  check(`转场不止那三个（现在有 ${transOpts} 种）`, transOpts >= 15, String(transOpts));
  check('接缝上出现了转场标记', (await page.locator('.tl-trans').count()) >= 1,
    String(await page.locator('.tl-trans').count()));

  /**
   * ⚠ **重叠类转场处，播放头必须归后一段。**
   *
   * 推移/叠化各吃掉 0.5 秒，于是下一段的起点比上一段的终点还早 ——
   * 两段的时间范围是**叠在一起**的。用"第一个还没结束的"去找，
   * 在重叠区里会找回上一段：跳到下一段的起点跳完还在原地，
   * 下一帧又触发跳转，播放就死在那个接缝上再也过不去。
   * 用户报上来的原话："点击按钮演示一直卡在那边播放不下去"。
   *
   * 素材播不了（走查里是假文件），所以量的不是"播过去了"，
   * 而是**跳到接缝那一刻，预览加载的是哪一段的素材** —— 同一个判断。
   */
  const seamKey = await page.evaluate(() => document.querySelectorAll('.tl-clip')[1].dataset.shot);
  const seamShot = seamKey.split('#')[0];
  const seamPath = await page.evaluate(
    ([id, sid]) => fetch(`/api/projects/${id}`).then((r) => r.json())
      .then((pp) => (pp.shots.find((x) => x.id === sid) || {}).videoPath || ''),
    [proj.id, seamShot]);
  const seamBox = await tlClips.nth(1).boundingBox();
  const rulerBox = await page.locator('.tl-ruler').boundingBox();
  await page.mouse.click(seamBox.x + 2, rulerBox.y + rulerBox.height / 2);
  await page.waitForTimeout(500);
  const loaded = await page.evaluate(() => document.querySelector('.tl-video')?.getAttribute('src') || '');
  check('跳到转场接缝上时，预览加载的是后一段（否则播放会卡死在这儿）',
    Boolean(seamPath) && loaded.includes(encodeURIComponent(seamPath).slice(-14)),
    `想要 ${seamPath} / 实际 ${loaded.slice(-60)}`);

  const fxSel = page.locator('.tl-props select').nth(1);
  await fxSel.selectOption('bw');
  await page.waitForTimeout(700);
  check('画面效果存下来了',
    Object.values((await readEdit()).clips || {}).some((c) => c.fx === 'bw'),
    JSON.stringify((await readEdit()).clips));

  await page.locator('.tl-props button:has-text("有声")').click();
  await page.waitForTimeout(700);
  check('单镜静音存下来了',
    Object.values((await readEdit()).clips || {}).some((c) => c.mute === true),
    JSON.stringify((await readEdit()).clips));

  /**
   * ── "不用"之后必须能放回来 ──
   *
   * 标成不用的那一镜会从时间线上**消失**。左边那栏素材架就是它唯一的退路 ——
   * 没有它的话这个操作是单向的，而"不用"本来就该是可逆的。
   */
  const nUsed = await tlClips.count();
  await page.locator('.tl-props button:has-text("不用这一段")').click();
  await page.waitForTimeout(800);
  check('标成"不用"之后它从时间线上消失了',
    (await tlClips.count()) === nUsed - 1, `${nUsed} → ${await tlClips.count()}`);
  check('但它还在左边的素材架上（不用是可逆的）',
    (await page.locator('.tl-card.off').count()) === 1,
    String(await page.locator('.tl-card.off').count()));
  await page.locator('.tl-card.off button:has-text("放回来")').click();
  await page.waitForTimeout(800);
  check('放回来之后又出现在时间线上', (await tlClips.count()) === nUsed,
    String(await tlClips.count()));

  // ── 播放头 ──
  const ruler = page.locator('.tl-ruler');
  const rb = await ruler.boundingBox();
  await page.mouse.click(rb.x + rb.width * 0.5, rb.y + rb.height / 2);
  await page.waitForTimeout(500);
  const headLeft = await page.evaluate(() => parseFloat(document.querySelector('.tl-head').style.left));
  check('点刻度尺能把播放头挪过去', headLeft > 10, String(headLeft));
  check('时码跟着走了',
    !/^00:00\.00/.test(await page.locator('.tl-clock').innerText()),
    await page.locator('.tl-clock').innerText());

  // ── 音轨 ──
  /**
   * 声音的问题是整片性的（"音效太吵""音乐盖住台词"从来不是某一镜的事），
   * 所以开关做在轨道名上，而不是每一段里 —— 摆在段里人要点十三次。
   */
  check('三条声音轨都在（台词/音效/音乐）',
    /台词/.test(await page.locator('.tl-labels').innerText())
    && /音效/.test(await page.locator('.tl-labels').innerText())
    && /背景音乐/.test(await page.locator('.tl-labels').innerText()),
    await page.locator('.tl-labels').innerText());
  const voiceEye = page.locator('.tl-lab:has-text("台词") .tl-eye');
  await voiceEye.click();
  await page.waitForTimeout(800);
  check('点轨道上那只眼睛能关掉整条台词轨',
    (await readEdit()).tracks?.voice === false, JSON.stringify((await readEdit()).tracks));
  await page.locator('.tl-lab:has-text("台词") .tl-eye').click();
  await page.waitForTimeout(800);
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
    buffer: Buffer.from('ID3      fake-mp3-body', 'binary')
  });
  await page.waitForTimeout(1600);
  const afterMusic = await readEdit();
  check('背景音乐传上去了，路径记在项目里', Boolean(afterMusic.music?.path), JSON.stringify(afterMusic.music));
  check('音乐的默认参数是"压在台词底下 + 自动避让"',
    afterMusic.music?.gain <= 0.3 && afterMusic.music?.duck !== false, JSON.stringify(afterMusic.music));
  check('音乐轨上出现了一条铺满全片的块',
    (await page.locator('.tl-ab.music').count()) === 1,
    String(await page.locator('.tl-ab.music').count()));
  check('说清楚曲子的授权要自己确认',
    /授权/.test(await page.locator('.cut-audio').innerText()), '');

  const duckBox = page.locator('.cut-track label[title*="自动让开"] input[type=checkbox]');
  if (await duckBox.count()) {
    await duckBox.uncheck();
    await page.waitForTimeout(800);
    check('关掉自动避让也存得下来', (await readEdit()).music?.duck === false,
      JSON.stringify((await readEdit()).music));
  }
  await page.locator('.cut-track button:has-text("移除")').click();
  await page.waitForTimeout(900);
  check('撤下音乐之后项目里就没有了', !(await readEdit()).music, JSON.stringify((await readEdit()).music));

  // ── 缩放 ──
  const wNormal = await widthOf(0);
  await page.locator('.tl-bar button:has-text("＋")').click();
  await page.waitForTimeout(400);
  check('放大之后片段变宽（时间线是可缩放的）',
    (await widthOf(0)) > wNormal * 1.2, `${wNormal} → ${await widthOf(0)}`);
  await page.locator('.tl-bar button:has-text("适应窗口")').click();
  await page.waitForTimeout(400);
  check('「适应窗口」把整条片子收回一屏',
    (await widthOf(0)) < (await page.locator('.tl-scroll').boundingBox()).width,
    String(await widthOf(0)));

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
/**
 * ── 小剪刀 / 删除 / 拉满 ──
 */
{
  const clipsNow = await tlClips.count();
  const firstBox = await tlClips.first().boundingBox();
  await page.mouse.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.waitForTimeout(400);
  // 把播放头挪到这一段中间再切 —— 两边各要留够 0.3 秒
  const ruler2 = await page.locator('.tl-ruler').boundingBox();
  await page.mouse.click(ruler2.x + firstBox.width / 2, ruler2.y + ruler2.height / 2);
  await page.waitForTimeout(400);
  check('小剪刀在播放头落到片段中间时可以按', !(await page.locator('.tl-cut').isDisabled()), '');
  await page.locator('.tl-cut').click();
  await page.waitForTimeout(900);
  check('切完时间线上多了一段',
    (await tlClips.count()) === clipsNow + 1, `${clipsNow} → ${await tlClips.count()}`);
  const afterSplit = await readEdit();
  check('切出来的那一段带着 # 号（和原来那一镜连着）',
    (afterSplit.order || []).some((k) => k.includes('#')), JSON.stringify(afterSplit.order));
  /**
   * ⚠ 两段的入出点必须**首尾相接**，中间不能少一截也不能重一截。
   * 少一截 = 成片里丢帧，重一截 = 同一段画面放两遍。
   */
  const parts = (afterSplit.order || []).filter((k) => k.split('#')[0] === (afterSplit.order || [])[0].split('#')[0]);
  if (parts.length === 2) {
    const [p1, p2] = parts.map((k) => afterSplit.clips[k]);
    check('两段首尾相接，不丢帧也不重复',
      Math.abs(p1.out - p2.in) < 0.01, `${JSON.stringify(p1)} / ${JSON.stringify(p2)}`);
  }

  // 删除：切出来的那一段直接拿掉（另一半还在，所以是可逆的）
  const beforeDel = await tlClips.count();
  await page.locator('.tl-del').click();
  await page.waitForTimeout(900);
  check('删除把选中的那一段拿掉了',
    (await tlClips.count()) === beforeDel - 1, `${beforeDel} → ${await tlClips.count()}`);

  // 拉满整段
  const lastBox = await tlClips.last().boundingBox();
  await page.mouse.click(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
  await page.waitForTimeout(400);
  await page.locator('.tl-props button:has-text("拉满整段")').click();
  await page.waitForTimeout(800);
  const full = await readEdit();
  check('「拉满整段」把出点拉到素材的完整长度',
    Object.values(full.clips || {}).some((c) => c.out === 5), JSON.stringify(full.clips));
}

/**
 * ── 「重新合成」这颗按钮按得动吗 ──
 *
 * 它原来调的是一个这个文件里**根本不存在的函数**，点下去抛 ReferenceError，
 * 界面纹丝不动。而走查一直是绿的，因为从来没点过它。
 */
sent.length = 0;
await page.locator('button:has-text("重新合成")').click();
await page.waitForTimeout(1500);
check('点「重新合成」真的发出了合成请求',
  sent.some((x) => /POST \/api\/projects\/.*\/stage\/compose/.test(x)),
  sent.slice(-6).join(' | '));

check('说清楚重新合成不花钱',
  /一分钱不花|不花钱/.test(await page.locator('#view-inner').innerText()), '');
/**
 * 预览不等于成片这件事**必须说出来**：自动避让和转场是合成那一步做的，
 * 预览里听不到。不说的话人会拿预览当最终效果，然后觉得"配的乐没生效"。
 */
check('如实说明了预览不等于成片',
  /不等于成片/.test(await page.locator('.tl-stage').innerText()),
  (await page.locator('.tl-stage').innerText()).slice(0, 120));

/**
 * ── 连不通的时候，红叉点得开吗 ──
 *
 * 用户报上来的原话是四行光秃秃的
 *     剧本 openai ✕ / 调度 openai ✕ / 复核 openai ✕ / 出图 openai ✕
 * 而真正的原因当时只挂在 title 上 —— 鼠标不悬停就永远看不到，
 * 于是第一反应是去翻密钥，全是白折腾。
 *
 * 这里把服务商指到一个**确定连不上**的地址（本机一个没人监听的端口），
 * 重新加载页面，然后点那个红叉，看它说不说人话。
 * 放在最后跑：这一步会把路由改坏，后面的用例都别想用了。
 */
console.log('\n连不通时的解释');
await page.evaluate(() => fetch('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // ⚠ 开机自检在这个走查里是关着的（省时间），这一节要用它，得先打开
  body: JSON.stringify({ autoCheckOnStart: true, baseUrls: { volcengine: 'http://127.0.0.1:45999/v3' } })
}));
/**
 * ⚠ 必须 reload()，不能 goto 同一个地址。
 *
 * 地址一模一样（只有 hash）时浏览器不会重新加载页面，开机自检也就不会再跑一次 ——
 * 于是这一节永远看到 0 条红的，而产品代码是好的。
 */
await page.reload();
// 开机自检是异步发出去的，连不上要等 TCP 拒绝回来
await page.waitForTimeout(4000);
const badSeg = page.locator('.chain-seg.bad').first();
const nBad = await page.locator('.chain-seg.bad').count();
check(`连不通的能力在信号链上标红了（${nBad} 条）`, nBad >= 1, String(nBad));
if (nBad >= 1) {
  check('红叉是能点的（光标是手型）',
    (await badSeg.evaluate((el) => getComputedStyle(el).cursor)) === 'pointer', '');
  await badSeg.click();
  await page.waitForTimeout(400);
  const why = await page.locator('.route-why').innerText().catch(() => '');
  /**
   * ⚠ 量的是"说没说到原因"，不是"有没有弹出个东西"。
   * 弹一个写着"连接失败"的框和不弹，对用户是一样的。
   */
  check('点开之后写着到底为什么连不通',
    /连不上|拒绝连接|连接失败|超时/.test(why), why.slice(0, 160));
  /**
   * ⚠ 量的是"有没有把原因翻译成人话"。
   * 一句 `连接失败：fetch failed` 和不说是一样的 —— 而那正是这一条第一次跑出来的样子
   *（双栈失败被打包成 AggregateError，真正的错误码被埋掉了）。
   */
  check('原因是人话，不是一句 fetch failed',
    /拒绝连接|解析不了|连接超时/.test(why) && !/^连接失败：fetch failed/.test(why),
    why.slice(0, 200));
  check('按钮跟着原因走：网络问题不该只给"去配密钥"',
    /系统代理|接口根地址/.test(await page.locator('#route-banner').innerText()),
    (await page.locator('#route-banner').innerText()).slice(0, 200));
}

/**
 * ── 场地图：真在浏览器里拖 ──
 *
 * 这一节量的是"服务端全绿而界面一动不动"那一类问题。几何算得对不对
 * 已经由自检那 30 多条守着了 —— 这里只管三件在浏览器里才成立的事：
 *
 *   ① 面板真的画出来了（SVG 在 DOM 里，不是一块空 div）
 *   ② 点「摆上来」真的发出了那一次请求（按钮调了个不存在的函数，就是这么漏掉的）
 *   ③ **拖动过程中不存盘、松手才存一次** —— 这一条只有量请求数才看得出来
 */
console.log('\n场地图');
// 第二个场景直接写进设定集：不动前面那份 BIBLE，免得影响已经跑过的每一步
await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  p.bible.scenes.push({ name: '栈桥', appearance: '伸进雾里的木栈桥', sheetPrompt: '' });
  await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bible: p.bible })
  });
}, proj.id);
/**
 * ⚠ 必须 reload()，不能 goto 同一个地址。
 *
 * 地址一模一样（只有 hash）时浏览器根本不重新加载 —— 于是内存里那份
 * project 还是老的，刚 PATCH 进去的那个场景不在里面。这一条第一次跑
 * 就栽在这儿：报"没摆上来的场景列不出来"，看起来像功能坏了，
 * 其实是测试站错了地方。（这个坑在信号链那一节已经写过一次了。）
 */
await page.reload();
await page.waitForTimeout(1500);
await step('设定集').click();
await page.waitForTimeout(1500);

const sitePanel = page.locator('.site-panel').first();
check('设定集这一步能看到场地图', (await sitePanel.count()) > 0);

// 一片场地都还没有时，不能是一块空白 —— 空白让人以为功能坏了
const emptyWhy = await page.locator('.site-empty-why').first().innerText().catch(() => '');
check('还没有场地时说清了这是干什么的',
  /场景/.test(emptyWhy) && /太阳|方向|北/.test(emptyWhy), emptyWhy.slice(0, 120));

sent.length = 0;
await page.locator('.site-empty button').first().click();
await page.waitForTimeout(900);
check('建图真的发出了请求，不是只改了界面',
  sent.some((s) => s === 'POST /api/projects/' + proj.id + '/scene-place'),
  sent.slice(-4).join(' | '));
check('画布出来了', (await page.locator('svg.site-canvas').count()) > 0);
check('第一个场景摆上去了', (await page.locator('.site-place').count()) === 1);

// 把第二个场景也摆上来
const addBtn = page.locator('.site-row button', { hasText: '栈桥' }).first();
check('没摆上来的场景列得出来', (await addBtn.count()) > 0);
await addBtn.click();
await page.waitForTimeout(900);
check('两个场景都在图上了', (await page.locator('.site-place').count()) === 2);
/**
 * 新场景不能落在原点 —— 落在原点会正好盖住第一个，看起来像"没加上"。
 * 量两个圆点的屏幕坐标：重合就是没拖开。
 */
const centers = await page.locator('.site-place').evaluateAll(
  (ns) => ns.map((n) => `${n.getAttribute('cx')},${n.getAttribute('cy')}`)
);
check('新场景没有盖在第一个上面', centers[0] !== centers[1], centers.join(' / '));

/**
 * 拖一个场景。
 *
 * ⚠ page.mouse 用的是**视口坐标**，而 boundingBox() 回的是页面坐标 ——
 * 页面滚动过之后两者差一个滚动量，拖动会落在空处而**不报任何错**。
 * 先把画布滚进视口再取坐标。
 */
await page.locator('svg.site-canvas').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const dot = page.locator('.site-place').first();
const box = await dot.boundingBox();
sent.length = 0;
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
// 分几步移动：一步到位的话 pointermove 只发一次，测不出"拖动中在不在存"
for (let i = 1; i <= 8; i += 1) {
  await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2 + i * 4);
  await page.waitForTimeout(30);
}
const duringDrag = sent.filter((s) => s.includes('scene-place')).length;
/**
 * ⚠ 这一条是这一节里最值钱的。
 *
 * 把存盘挂在 onChange（每一帧都响）上，本机跑起来完全看不出问题 ——
 * 都是毫秒级。连服务器就是一串请求排队，表现是"拖起来很卡"，
 * 而没人会想到是自己在拖的时候一直在存。
 */
check('拖动过程中一次都不存', duringDrag === 0, `拖到一半已经发了 ${duringDrag} 次`);
await page.mouse.up();
await page.waitForTimeout(900);
const afterDrag = sent.filter((s) => s.includes('scene-place')).length;
check('松手存了一次', afterDrag === 1, `松手后共 ${afterDrag} 次`);

// 选中之后要说得出"它在别处的哪个方向、多远"—— 这是整块画布要交付的东西
const pickText = await page.locator('.site-pick').first().innerText().catch(() => '');
check('选中的场景说得出到别处的方位和距离',
  /(东|南|西|北)/.test(pickText) && /米/.test(pickText), pickText.replace(/\n/g, ' ').slice(0, 140));

// 存下去的位置得能读回来 —— 界面上动了而盘上没动，是最难发现的一类
const saved = await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  return (p.bible.scenes || []).filter((s) => s.place).map((s) => `${s.name}:${s.place.site}`);
}, proj.id);
check('位置真的落到盘上了（不是只在界面上）', saved.length === 2, saved.join(' | '));

check('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(bad ? `\n\x1b[31m${bad} 项没过\x1b[0m` : '\n\x1b[32m界面走查全过\x1b[0m');
process.exit(bad ? 1 : 0);
