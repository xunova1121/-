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
import { fileURLToPath } from 'node:url';
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
      /**
       * 增量补设定集要能测到"真的多出一个人"那条路。
       * 所以看**用户那条消息**里有没有新角色的名字：有就多回一个人和一个场景，
       * 模拟"第二章冒出了第一章没有的人"。
       */
      const user = JSON.stringify(body.messages?.[1]?.content || '');
      const richer = {
        ...BIBLE,
        characters: [...BIBLE.characters, { name: '老周', role: '船工', appearance: '花白胡子，藏青短打' }],
        scenes: [...BIBLE.scenes, { name: '灯塔下', appearance: '锈迹斑斑的灯塔基座' }]
      };
      /**
       * 大纲那两条也要打桩。
       *
       * ⚠ 少了它们，buildOutline 会拿到 '{}'，拆出 0 场然后抛
       * "模型没有拆出场次" —— 看起来像功能坏了，其实是打桩没跟上。
       * 这一节第一次跑就是这么红的。
       */
      const OUTLINE = {
        beats: [
          { scene: '码头', time: '清晨', characters: ['阿澜'], summary: '阿澜走向栈桥，例行巡查。', dialogue: '设备正常。', seconds: 20 },
          { scene: '码头', time: '清晨', characters: ['阿澜'], summary: '发现缆绳被割断。', dialogue: '这里的缆绳被人动过，割口是新的。', seconds: 25 },
          { scene: '栈桥', time: '清晨', characters: ['阿澜'], summary: '望向雾里的灯塔。', dialogue: '', seconds: 12 }
        ]
      };
      const REVISE = {
        ops: [
          { op: 'edit', id: 'b-02', fields: { seconds: 12 } },
          { op: 'insert', after: 'b-01', beat: { scene: '码头', summary: '一只海鸟掠过水面。', dialogue: '', seconds: 5 } }
        ],
        note: '第二场砍一半，中间插个空镜换气'
      };
      const content = system.includes('美术总监')
        ? JSON.stringify(user.includes('老周') ? richer : BIBLE)
        : system.includes('分场编辑') ? JSON.stringify(OUTLINE)
        : system.includes('改动指令') ? JSON.stringify(REVISE)
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


/**
 * ⚠ **import 必须按这个脚本自己的位置算，绝对不能写死绝对路径。**
 *
 * 这里原来写的是 `import('/home/user/-/desktop/core/settings.js')` —— 我这台
 * 开发机的路径。两个后果，第二个要命：
 *   ① 换台机器（比如服务器上的 ~/fd/desktop）直接跑不起来，路径不存在
 *   ② 在另一份检出里跑，它会**静默地 import 另一份代码**然后报绿 ——
 *      走查了半天，验的根本不是眼前这份分支
 * ② 就是"验错了对象"，比红灯坏得多：红灯会有人看，绿灯没人查。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = (name) => path.join(HERE, '..', 'core', name);

const settings = await import(CORE('settings.js'));
const vault = await import(CORE('vault.js'));
const store = await import(CORE('store.js'));
const { listen } = await import(CORE('server.js'));


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
 * ══════════ 开跑之前那张清单，真的画出来了吗 ══════════
 *
 * 服务端那边已经验过判据本身。这里补的是**它有没有到屏幕上** ——
 * 清单是异步拉的，接口对了但渲染没接上的话，服务端自检照样全绿，
 * 而用户看到的是那块地方什么都没有。
 */
console.log('\n开跑之前的清单');
{
  await page.goto(`${url}#/studio/${proj.id}`);
  await page.waitForTimeout(1200);
  await page.locator('.nav-step', { hasText: '视频生成' }).first().click();
  await page.waitForTimeout(2000);
  const box = page.locator('.stepcheck').first();
  check('这一步的按钮上面有一块清单', (await box.count()) > 0);
  if (await box.count()) {
    const txt = await box.innerText();
    check('说得出这一步要跑几镜', /这一步 \d+ 镜/.test(txt), txt.slice(0, 100));
    /**
     * 这个夹具里分镜出完了但图没出（走查只跑到分镜），
     * 所以"还没有分镜图"这条 blocker 必须在。
     * 它不在的话，说明清单虽然画出来了，但判据没接上真实数据。
     */
    check('点出了"还没出图就出视频"这条', /还没有分镜图/.test(txt), txt.slice(0, 200));
    check('而且说了会怎样，不只是报一个数',
      /最贵的一步|接不上/.test(txt), txt.slice(0, 300));
  }
}


/**
 * ── 预演台 ──
 *
 * 这块是**拖出来**的：单元测试能验几何算得对不对，验不了
 * "手指按下去、拖过去，那个圆点跟不跟着走"。而拖动最容易坏的地方
 * 恰恰在显示尺寸和 viewBox 不一致的换算上 —— 那种错只有真拖一次才看得见。
 */
console.log('\n镜头卡那一排按钮');
/**
 * ⚠ 这一排必须**换行**，不能溢出。
 *
 * 用户的原话："这个生成清单后面还有文字，但是看不见，再后面不知道有没有"。
 * .shot-head 原来是 flex 但没写 flex-wrap（默认 nowrap），按钮又是 flex:none，
 * 于是一排放不下就被切掉 —— 按钮还在、点得到，只是**看不见**。
 * 这种漏法比崩溃隐蔽：功能在、测试绿、用户找不到。
 */
{
  const head = page.locator('.shot-card .shot-head').first();
  const info = await head.evaluate((n) => {
    const box = n.getBoundingClientRect();
    const btns = [...n.querySelectorAll('.shot-edit-btn')];
    return {
      labels: btns.map((b) => b.textContent.trim()),
      over: btns.filter((b) => b.getBoundingClientRect().right > box.right + 1).map((b) => b.textContent.trim()),
      rows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size
    };
  });
  console.log(`  这一排共 ${info.labels.length} 颗：${info.labels.join(' / ')}`);
  console.log(`  占了 ${info.rows} 行`);
  check('没有一颗按钮被切出卡片外（切掉的那几颗用户根本看不见）',
    info.over.length === 0, `露在外面的：${info.over.join('、') || '无'}`);
  check('数量对得上（漏一颗就是一个功能没人找得到）', info.labels.length >= 4, String(info.labels.length));
}

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
/**
 * 现在点开的是**全屏弹窗**，不再是编辑面板里那个折叠块。
 *
 * 用户的原话：「codex 的预演台太窄了，我都没办法操作」。卡片那一栏四百来像素，
 * 3D 画布挤在里面圆点叠成一团 —— 下面那段拖拽要"两个端点都先验证在视口内"
 * 才做得成，那本来就是这个面板在那个宽度下不好用的证据。
 */
const previz = page.locator('.previz-modal').first();
check('点一下弹出全屏弹窗（不再是那个挤在卡片里的折叠块）', (await previz.count()) > 0);
check('弹窗比卡片宽得多（画布终于有地方了）', await previz.evaluate(
  (n) => n.querySelector('.previz-modal-box')?.getBoundingClientRect().width > 900),
  String(await previz.evaluate((n) => Math.round(n.querySelector('.previz-modal-box')?.getBoundingClientRect().width || 0))));
check('弹窗自带保存（原来排完位得关掉再回编辑面板点另一个保存）',
  await previz.locator('button', { hasText: '保存这一镜的机位' }).count() === 1);
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
  /**
   * ⚠ 先切回「俯视排位」。
   *
   * 加了 3D 之后，这个面板**默认开在 3D 导演画布**，2D 那张 svg 是
   * display:none —— 于是下面找 `.previz-cam` 会一直等到超时，
   * 看起来像"2D 排位没了"。实际上它好好的，切过去就在：
   * 实测拖一次机位，圆点 cx/cy 从 160,240 变到 240,96，
   * 读数从「机位在主体正面方向」变成「机位在主体右侧侧后方向」。
   *
   * 功能没坏，是走查没跟上界面的改动。
   */
  const topView = page.locator('button', { hasText: '俯视排位' }).first();
  check('预演台有 2D／3D 切换', (await topView.count()) > 0);
  if (await topView.count()) {
    await topView.evaluate((el) => el.click());
    await page.waitForTimeout(1200);
  }

  const cam = page.locator('.previz-cam').first();
  await cam.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await cam.boundingBox();
  /**
   * ⚠ 终点必须取**圆点自己所在的那张 svg**，不能用
   * `.previz-canvas` 的 .first()。
   *
   * 加了 3D 之后页面上有两张 `.previz-canvas`，.first() 可能是隐藏的那张 ——
   * 它的 boundingBox 要么是 null、要么落在视口外（实测拿到过 y=-295），
   * 于是鼠标松在一个负坐标上，拖拽等于没发生。而现象是"读数没变"，
   * 看起来像功能坏了。查这个坑花的时间比修它长得多。
   */
  const cbox = await cam.evaluate((el) => {
    const r = el.ownerSVGElement.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const vp = page.viewportSize();
  check('机位圆点在视口里（不然鼠标会按在别处，测了个寂寞）',
    Boolean(box) && box.y >= 0 && box.y + box.height <= vp.height,
    `box.y=${box?.y?.toFixed(0)} 视口高=${vp.height}`);
  if (box && cbox) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(cbox.x + cbox.width * 0.75, cbox.y + cbox.height * 0.3, { steps: 14 });
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
  /**
   * ⚠ 这里**不能**用 `.previz-row button` 的 .first()，踩过：
   *
   * 摆上地标之前，全页只有「地标」那一排有「窗」，.first() 恰好是对的；
   * 可是摆上之后，「焦点/景深」那一排会多出一个同名的「窗」（可以对焦到它），
   * 而焦点行**排在地标行前面** —— 于是 .first() 悄悄改指到了对焦按钮上。
   * 第二次点击等于设了个对焦点，地标当然撤不掉，红的是测试自己点错了地方。
   *
   * 教训是那个反复出现的老毛病：**动作本身改变了 DOM，位置选择器就会失准**。
   * 所以锁死到「地标」那一行上，前后两次点的保证是同一个按钮。
   */
  const markRow = page.locator('.previz-modal .previz-row').filter({ hasText: '地标' });
  const markBtn = markRow.locator('button', { hasText: '窗' }).first();
  if (await markBtn.count()) {
    await markBtn.click();
    await page.waitForTimeout(400);
    check('点一下就把地标摆到图上', (await page.locator('.previz-mark').count()) >= 1,
      String(await page.locator('.previz-mark').count()));
    const withMark = await page.locator('.previz-chips').first().innerText().catch(() => '');
    check('并且当场算出它在画面哪一边（或者出画了）',
      /窗：(画面左|画面右|正中|画外)/.test(withMark), withMark.slice(0, 160));
    // 再点一下收回去 —— 摆错了要能撤。点的是同一个按钮，不是同名的另一个
    await markBtn.click();
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

  /**
   * ⚠ 跑完一定要**把弹窗关掉**。
   *
   * 它是全屏遮罩，开着的时候后面所有测试点什么都点不到 —— 第一版忘了关，
   * 于是下一节点「设定集」那颗按钮超时死掉，报错说
   * `.previz-assets … intercepts pointer events`，看起来像是资产面板的 bug，
   * 其实是这里没收尾。
   */
  await page.locator('.previz-modal button', { hasText: '关闭' }).first().click();
  await page.waitForTimeout(300);
  check('✕ 关得掉（不关的话它挡住整页）',
    (await page.locator('.previz-modal').count()) === 0);

  // Esc 也要能关 —— 全屏遮罩只留一个出口是很容易把人困住的
  await page.locator('.shot-edit-btn', { hasText: '预演台' }).first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('按 Esc 也关得掉', (await page.locator('.previz-modal').count()) === 0);
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

/**
 * ── 问题旁边那条出口 ──
 *
 * 只报"这座山在两个场景里差了 180°"是没用的：人下一秒就要问"那我该怎么办"。
 * 这一节量的是那颗按钮**真的把盘上的数据改了**，不是只让提示消失。
 */
// 造一个真对不上的局面：场地上定「山」在北，两个场景里各摆成别的方位
await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  for (const s of p.bible.scenes) {
    if (!s.place) continue;
    s.layout = { marks: [{ name: '门', x: 1, y: 2 }, { name: '山', far: true, deg: 200 }], sun: { deg: 40, elev: 'high' } };
  }
  await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bible: p.bible })
  });
  await fetch(`/api/projects/${id}/site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: '外景', marks: [{ name: '山', far: true, deg: 20 }], sun: { deg: 135, elev: 'low' } })
  });
}, proj.id);
await page.reload();
await page.waitForTimeout(1500);
await step('设定集').click();
await page.waitForTimeout(1500);

const issueText = await page.locator('.site-issues').first().innerText().catch(() => '');
check('对不上的地方报出来了，而且点名是"场地图上定的"那一份',
  /场地图上定的/.test(issueText), issueText.replace(/\n/g, ' ').slice(0, 160));

const fixBtn = page.locator('.site-issues button').first();
check('问题旁边给了一条出口，不是只说"这里不对"', (await fixBtn.count()) > 0);
if (await fixBtn.count()) {
  await fixBtn.scrollIntoViewIfNeeded();
  await fixBtn.click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    const s = (p.bible.scenes || []).find((x) => x.place);
    return {
      far: (s.layout.marks || []).find((m) => m.far && m.name === '山')?.deg,
      near: (s.layout.marks || []).find((m) => m.name === '门'),
      sun: s.layout.sun
    };
  }, proj.id);
  check('远景地标真的被对齐到场地图那一份了（不是只让提示消失）',
    after.far === 20, JSON.stringify(after));
  check('太阳也对齐了', after.sun?.deg === 135 && after.sun?.elev === 'low', JSON.stringify(after.sun));
  /**
   * ⚠ 这一条是这一节里最要紧的。
   *
   * 近处地标一起被覆盖的话，这颗按钮就从"对齐远景"变成了
   * "把每个场景的房间布局清空"—— 而它字面上看起来是在帮忙，且不可撤销。
   */
  check('门窗那些近处地标一个都没动',
    after.near && after.near.x === 1 && after.near.y === 2, JSON.stringify(after.near));
  const gone = await page.locator('.site-issues').first().innerText().catch(() => '');
  check('对齐完之后提示跟着消失了', /都对得上/.test(gone), gone.replace(/\n/g, ' ').slice(0, 120));
}

/**
 * ── 剧本一章一章加 ──
 *
 * 这条路上原来有三个洞，每一个都是**静默**的。这一节按用户真会走的顺序点一遍：
 * 分章 → 追加第二章 → 补设定集 → 看分镜体检有没有把"点名了不存在的人"报出来。
 */
console.log('\n剧本一章一章加');
/**
 * ⚠ 先把上游地址**接回打桩服务**。
 *
 * 上面「连不通时的解释」那一节故意把 volcengine 的根地址改成了一个
 * 死端口（127.0.0.1:45999），用来验红叉说不说人话。它改的是全局设置，
 * 于是**这之后每一次调模型都会失败** —— 而这一节要真的调一次模型。
 *
 * 第一版就栽在这儿：补设定集一条都没补进来，看起来像功能坏了，
 * 其实是上一节留下的地址还没还回去。
 */
await page.evaluate((u) => fetch('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ autoCheckOnStart: false, baseUrls: { volcengine: u } })
}), stubUrl);

// 先分章。测试项目的剧本很短，不分章的话章节面板根本不出现
await page.evaluate(async (id) => {
  await fetch(`/api/projects/${id}/chapters/split`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
}, proj.id);
await page.reload();
await page.waitForTimeout(1500);
await step('剧本').click().catch(() => {});
await page.waitForTimeout(1200);

const chBefore = await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  return { n: (p.chapters || []).length, first: (p.chapters || [])[0]?.script || '' };
}, proj.id);
check('分出章节了', chBefore.n >= 1, String(chBefore.n));

const apPanel = page.locator('details.append-chapter').first();
check('章节面板上有「追加一章」', (await apPanel.count()) > 0);
if (await apPanel.count()) {
  await apPanel.locator('summary').click();
  await page.waitForTimeout(300);
  await apPanel.locator('input').fill('第二章 靠岸');
  await apPanel.locator('textarea').fill('船靠上了灯塔下的礁石。老周跳下船，把缆绳系紧。');
  await apPanel.locator('button').click();
  await page.waitForTimeout(2000);

  const chAfter = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    return {
      n: (p.chapters || []).length,
      first: (p.chapters || [])[0]?.script || '',
      firstDone: (p.chapters || [])[0]?.stageStatus?.script,
      shots: (p.shots || []).length
    };
  }, proj.id);
  check('章数多了一章', chAfter.n === chBefore.n + 1, `${chBefore.n} → ${chAfter.n}`);
  /**
   * ⚠ 这一条就是这颗按钮存在的全部理由。
   *
   * 手工往剧本框里粘贴时最容易毁掉的就是它：碰掉前面一个空格，第一章
   * 就被判定"改过了"，已经出好的分镜全部作废重跑，而且不吭一声。
   */
  check('第一章的正文一个字都没变', chAfter.first === chBefore.first);
  check('第一章已跑完的分镜没被清掉', chAfter.shots > 0, `还剩 ${chAfter.shots} 镜`);
}

// ── 补设定集：只加新来的 ──
await step('设定集').click();
await page.waitForTimeout(1200);
const bibleBefore = await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  const a = (p.bible.characters || []).find((c) => c.name === '阿澜');
  return { names: (p.bible.characters || []).map((c) => c.name), alanSheet: a?.sheetPath, alanSeed: a?.seed };
}, proj.id);

const extBtn = page.locator('button:has-text("补上新增的角色和场景")').first();
check('设定集这一步有「补上新增的角色和场景」', (await extBtn.count()) > 0);
if (await extBtn.count()) {
  await extBtn.scrollIntoViewIfNeeded();
  sent.length = 0;
  await extBtn.click();
  await page.waitForTimeout(8000);
  // 先量"请求到底发出去没有" —— 按钮调了个不存在的函数这种事就是这么漏掉的
  check('点了真的发出请求',
    sent.some((x) => x.includes('extend-bible')), sent.slice(-6).join(' | '));
  /**
   * ⚠ 只读**那一行日志**，不要读整块面板。
   *
   * 第一版读的是整个 .panel，于是断言匹配到了按钮自己的字
   *（「补上**新增**的角色和场景」）—— 面板一片安静照样通过。
   * 又一条假绿，还是同一个毛病：量的范围比要量的东西大。
   */
  const extLog = await page.locator('.panel', { hasText: '剧本又加了新章' })
    .locator('.field-hint').last().innerText().catch(() => '');
  console.log(`      （面板日志：${extLog.replace(/\n/g, ' ').slice(0, 160)}）`);
  check('面板上把结果说出来了（不是点完一片安静）',
    /补了|没有新的角色|扫描|参考图/.test(extLog), JSON.stringify(extLog));
  const bibleAfter = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    const a = (p.bible.characters || []).find((c) => c.name === '阿澜');
    const z = (p.bible.characters || []).find((c) => c.name === '老周');
    return {
      names: (p.bible.characters || []).map((c) => c.name),
      scenes: (p.bible.scenes || []).map((s) => s.name),
      alanSheet: a?.sheetPath, alanSeed: a?.seed,
      zhouSheet: z?.sheetPath
    };
  }, proj.id);
  check('新角色补进来了', bibleAfter.names.includes('老周'), bibleAfter.names.join('、'));
  check('新场景也补进来了', bibleAfter.scenes.includes('灯塔下'), bibleAfter.scenes.join('、'));
  /**
   * ⚠ 老角色**一个字都不能动**。
   *
   * 被覆盖的话，"补一章"就变成了"把主角的脸和已经出好的参考图一起换掉"——
   * 观众对主角换脸最敏感，而且要到成片里才看得出来。
   */
  check('阿澜的参考图没被清掉（不是整份重出）',
    bibleAfter.alanSheet === bibleBefore.alanSheet && !!bibleAfter.alanSheet,
    `${bibleBefore.alanSheet} → ${bibleAfter.alanSheet}`);
  check('阿澜的 seed 也没变（换 seed 就是换脸）', bibleAfter.alanSeed === bibleBefore.alanSeed);
  check('新角色真的出了参考图', !!bibleAfter.zhouSheet, String(bibleAfter.zhouSheet));
}

/**
 * ── 点名了设定集里没有的人，要在分镜页说出来 ──
 *
 * 原来什么都不会发生：matchCharacters 找不到就 .filter(Boolean) 掉，
 * 那一镜没有参考图、没有外貌描述、复核没有基准，静默降级成"文生图"，
 * 而流水线一路绿。
 */
await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json();
  const s = p.shots[0];
  await fetch(`/api/projects/${id}/shots/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characters: '查无此人' })
  });
}, proj.id);
const q2 = await page.evaluate(async (id) => {
  const r = await (await fetch(`/api/projects/${id}/quality`)).json();
  return JSON.stringify(r.items || []);
}, proj.id);
check('成片体检把"点名了设定集里没有的人"报出来了',
  /查无此人|设定集里没有/.test(q2), q2.slice(0, 220));

/**
 * ── 大纲：模型回建议，人逐条勾 ──
 *
 * 用户的原话是"不要全部推到重来"。这一节量的就是那句话：
 * 没勾的一条都不动，锁着的一条都碰不了。
 */
/**
 * ══════════ 流式处理器里的错不许被吞 ══════════
 *
 * ⚠ 这一条是真事换来的：用户点「从剧本生成大纲」，按钮变「拆场次中…」
 * 然后变回来，**大纲没出来、也没有任何报错**。
 *
 * 原因在 lib.js 的 stream()：解析和分发包在同一个 try 里，
 * 那个 catch 本意只是"半截行忽略"，却把 onEvent 里抛的每一个错
 * 也一起吃掉了 —— 而 onEvent 做的正是渲染这类真会出错的事。
 *
 * 这个应用里最难查的一类问题就是"看起来什么都没发生"。
 * 所以这里直接验：处理器里抛一个错，它必须**炸出来**。
 */
console.log('\n流式：处理器里的错要炸出来，不能静默吞掉');
{
  const r = await page.evaluate(async () => {
    const lib = await import('/lib.js');
    let reached = false;
    try {
      await lib.stream(`/projects/${location.hash.split('/')[2] || ''}/outline/build`, {}, () => {
        reached = true;
        throw new Error('CANARY 处理器炸了');
      });
      return { reached, threw: false };
    } catch (err) {
      return { reached, threw: true, msg: String(err.message).slice(0, 40) };
    }
  });
  check(`处理器抛的错传到了调用方（${r.threw ? r.msg : '被吞了'}）`, r.threw === true);
  check('而且确实进过处理器（不然上一条等于没验）', r.reached === true);
}

console.log('\n大纲');
await step('剧本').click().catch(() => {});
await page.waitForTimeout(1000);

const buildBtn = page.locator('button:has-text("从剧本生成大纲")').first();
check('剧本这一步有大纲面板', (await buildBtn.count()) > 0);
if (await buildBtn.count()) {
  await buildBtn.scrollIntoViewIfNeeded();
  await buildBtn.click();
  await page.waitForTimeout(4000);
  const rows = await page.locator('.ob-row').count();
  check('大纲出来了，一行一场戏', rows >= 2, `${rows} 行`);
  /**
   * ⚠ 台词的硬下限要单独标出来。
   * 它和"节奏偏长"是完全不同的两件事：前者除非删台词否则压不下去。
   */
  check('有台词的场次标出了念完要多久',
    (await page.locator('.ob-floor').count()) > 0,
    await page.locator('.ob-list').first().innerText().catch(() => ''));

  // 手改一场的秒数：不经过模型，直接落盘
  const secs = page.locator('.ob-secs').first();
  await secs.fill('77');
  await secs.dispatchEvent('change');
  await page.waitForTimeout(900);
  const savedSecs = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    return p.outline?.beats?.[0]?.seconds;
  }, proj.id);
  check('手改秒数真的落盘了', savedSecs === 77, String(savedSecs));

  // ── 和模型商量 ──
  sent.length = 0;
  await page.locator('.ob-say').first().fill('第二场太拖了，砍一半');
  await page.locator('button:has-text("让它想想")').first().click();
  await page.waitForTimeout(3500);
  const ops = await page.locator('.ob-op').count();
  check('它把想改的每一条都摊出来了', ops >= 1, `${ops} 条`);
  const opText = await page.locator('.ob-op').first().innerText().catch(() => '');
  /**
   * ⚠ 每条必须说清**改之前是什么**。只说"第 3 场改成 2 分钟"，
   * 人没法判断该不该勾；说"60 → 120"才行。
   */
  check('每条都说得出"从什么变成什么"', /→/.test(opText), opText.slice(0, 120));

  const beforeApply = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    return (p.outline?.beats || []).length;
  }, proj.id);
  check('这时候还一条都没落盘（只是建议）',
    !sent.some((x) => x.includes('/outline/apply')), sent.slice(-4).join(' | '));

  /**
   * ⚠ 这一条是这一节的核心：**只应用勾中的**。
   * 把第一条取消勾选，然后应用 —— 剩下几条生效，取消的那条不能生效。
   */
  const boxes = page.locator('.ob-op input[type=checkbox]:not([disabled])');
  const nBox = await boxes.count();
  if (nBox >= 1) {
    await boxes.first().uncheck();
    await page.locator('button:has-text("应用勾中的")').first().click();
    await page.waitForTimeout(1500);
    const afterApply = await page.evaluate(async (id) => {
      const p = await (await fetch(`/api/projects/${id}`)).json();
      return { n: (p.outline?.beats || []).length, beats: (p.outline?.beats || []).map((b) => b.seconds) };
    }, proj.id);
    check('应用之后大纲变了', JSON.stringify(afterApply) !== JSON.stringify({ n: beforeApply, beats: [] })
      || afterApply.n !== beforeApply, JSON.stringify(afterApply));
    check('没勾的那条没生效（勾了几条就改几条）',
      afterApply.n <= beforeApply + Math.max(0, nBox - 1), JSON.stringify(afterApply));
  }

  /**
   * ── 自己动手改一场 ──
   *
   * ⚠ 这一条原来是缺的：面板上只有秒数是输入框，场景名、内容、台词
   * 都只能跟模型商量着改 —— 而后端白名单里这几样全都支持。
   * 接口有、界面没接，是最容易漏掉的一种缺口（自检全绿，功能"有"）。
   */
  const editOne = page.locator('.ob-row button', { hasText: /^改$/ }).first();
  check('每一场都能自己动手改', (await editOne.count()) > 0);
  if (await editOne.count()) {
    await editOne.scrollIntoViewIfNeeded();
    await editOne.click();
    await page.waitForTimeout(400);
    const box = page.locator('.ob-edit').first();
    check('打开的编辑框里，场景/内容/台词都能改',
      (await box.locator('input').count()) >= 3 && (await box.locator('textarea').count()) === 2);
    /**
     * 改台词时要**当场**看到"念完要多久" —— 那是这一场时长的硬下限。
     * 等拆完分镜才发现念不完，那时候改时长等于重拆。
     */
    await box.locator('textarea').last().fill('这一句是我自己敲进去的台词，念起来要花掉好几秒钟。');
    await page.waitForTimeout(300);
    const liveTxt = await box.locator('.field-hint').first().innerText().catch(() => '');
    check('边打字边算出台词念完要多久', /台词念完要 \d+ 秒/.test(liveTxt), liveTxt);

    await box.locator('input').first().fill('改过的场景名');
    await box.locator('button', { hasText: '存这一场' }).click();
    await page.waitForTimeout(1200);
    const saved = await page.evaluate(async (id) => {
      const p = await (await fetch(`/api/projects/${id}`)).json();
      const b0 = (p.outline?.beats || [])[0];
      return { scene: b0?.scene, dialogue: b0?.dialogue };
    }, proj.id);
    check('手改真的落盘了', saved.scene === '改过的场景名' && /自己敲进去/.test(saved.dialogue || ''),
      JSON.stringify(saved));
  }

  /**
   * ── 拆过分镜的场次锁住 ──
   *
   * 这是"不要全部推到重来"的落脚点：出过图的那几场，模型碰不到。
   */
  await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    const o = p.outline || { beats: [] };
    o.beats[0].locked = true;
    await fetch(`/api/projects/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outline: o })
    });
  }, proj.id);
  const refuse = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    const first = p.outline.beats[0];
    const r = await (await fetch(`/api/projects/${id}/outline/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'delete', id: first.id }] })
    })).json();
    const after = await (await fetch(`/api/projects/${id}`)).json();
    return { applied: r.applied, refused: r.refused, still: after.outline.beats[0].id === first.id };
  }, proj.id);
  check('锁着的场次删不掉', refuse.applied === 0 && refuse.still, JSON.stringify(refuse));
  check('并且说清了为什么、怎么才能改',
    /锁着/.test(refuse.refused?.[0]?.why || '') && /分镜/.test(refuse.refused?.[0]?.why || ''),
    JSON.stringify(refuse.refused));
}

/**
 * ── 分镜编辑器按下游分组 ──
 *
 * 用户问的是"标连续动作、选技法、绑说话人到底该出现在哪一步"。
 * 答案是：每一样属于**它喂的那一步**。这一节量的是那个分割真的摆出来了，
 * 而且「改了要重出 X」只在那样产物已经出过时才说。
 */
console.log('\n分镜编辑器：按下游分组');
await step('分镜').click();
await page.waitForTimeout(900);
await page.locator('.shot-card .shot-edit-btn').first().click().catch(() => {});
await page.waitForTimeout(500);
{
  /**
   * ⚠ **分组必须看得见**，不只是在 DOM 里分好。
   *
   * 下面那几条查的是"哪个字段归在哪一组"—— 全是结构。第一版就是结构全对、
   * 走查全绿，而屏幕上**什么都看不出来**：.shot-group 的背景写的是
   * var(--surface)，和它坐着的 .shot-card 一模一样（都是 #1D1913），
   * 边框那个 --line-soft 是 #262019，近黑压近黑。
   *
   * 用户的原话："你怎么分的组，我也没看出变化。"
   *
   * 分组存在的全部理由就是"让人一眼看出谁喂谁"。看不见 = 没做。
   * 所以这里量的是**真的颜色差**，不是"有没有这个 class"。
   */
  const contrast = await page.evaluate(() => {
    const g = document.querySelector('.shot-group');
    if (!g) return null;
    const card = g.closest('.shot-card');
    const px = (s) => (s.match(/\d+/g) || []).map(Number).slice(0, 3);
    const lum = ([r, gg, b]) => 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const gb = px(getComputedStyle(g).backgroundColor);
    const cb = px(getComputedStyle(card).backgroundColor);
    return { diff: Math.abs(lum(gb) - lum(cb)), gb: gb.join(','), cb: cb.join(',') };
  });
  check('分组和它坐着的卡片**颜色真的不一样**（不然等于没分组）',
    contrast && contrast.diff >= 4, JSON.stringify(contrast));

  // 「改了要重出 X」是代价，不能是一句灰得看不见的脚注
  const costChip = await page.evaluate(() => {
    const s = document.querySelector('.shot-group-head span');
    if (!s) return null;
    const cs = getComputedStyle(s);
    return { text: s.textContent.trim(), color: cs.color, bg: cs.backgroundColor };
  });
  check('「改了要重出什么」当面说出来了', /重出|重新/.test(costChip?.text || ''), JSON.stringify(costChip));

  const titles = await page.locator('.shot-group-head b').allInnerTexts();
  check('四组都在（出图 / 出视频 / 配音 / 合成）',
    ['出图用的', '出视频用的', '配音用的', '合成用的'].every((t) => titles.includes(t)),
    titles.join(' | '));

  const inGroup = async (title, label) => page.locator('.shot-group', { hasText: title })
    .locator('label', { hasText: label }).count();
  check('技法归在「出图用的」下面', (await inGroup('出图用的', '技法')) > 0);
  check('「和上一镜的关系」归在「出视频用的」下面',
    (await inGroup('出视频用的', '和上一镜')) > 0);
  check('「谁说的」归在「配音用的」下面', (await inGroup('配音用的', '谁说的')) > 0);
  check('转场归在「合成用的」下面', (await inGroup('合成用的', '转场')) > 0);

  /**
   * ⚠ 「改了要重出 X」**只在那样产物已经出过时**才显示。
   * 还没出过的时候它是废话，而废话会把真正要紧的那句挤没。
   *
   * ⚠ 只看**打开着的那个**编辑器。所有镜头的编辑器都建在 DOM 里
   * （靠 display 切换），不限定的话会把每一镜的提示都收进来 ——
   * 第一版就是这么红的，而那是测试站错了地方。
   */
  const state = await page.evaluate(async (id) => {
    const p = await (await fetch(`/api/projects/${id}`)).json();
    const s0 = (p.shots || [])[0];
    return { img: Boolean(s0?.imagePath), vid: Boolean(s0?.videoPath), aud: Boolean(s0?.audioPath) };
  }, proj.id);
  const redo = await page.locator('.shot-edit:visible .shot-group-redo').allInnerTexts();
  const says = (re) => redo.some((t) => re.test(t));
  check('出过图才提示要重出图', says(/重出这一镜的图/) === state.img,
    JSON.stringify({ state, redo }));
  check('出过视频才提示要重出视频', says(/重出视频/) === state.vid, JSON.stringify({ state, redo }));
  check('配过音才提示要重配音', says(/重新配音/) === state.aud, JSON.stringify({ state, redo }));
  /**
   * 出图那一条必须说清**视频也得跟着重出** —— 视频是跟着图走的。
   * 只说"重出图"的话，人重出完图，成片里还是旧视频，而且没人提醒。
   */
  if (state.img) {
    check('出图那条说清了视频也得跟着重出',
      says(/视频也得/), JSON.stringify(redo));
  }
  check('没出过的那几样一句废话都不说',
    redo.length === [state.img, state.vid, state.aud].filter(Boolean).length
      + (await page.locator('.shot-edit:visible .shot-group', { hasText: '合成用的' })
        .locator('.shot-group-redo').count()),
    JSON.stringify({ state, redo }));
}

/**
 * ════════ 钱：那个数真的出现在屏幕上了吗 ════════
 *
 * 自检验的是**算得对不对**，这一节验的是**说没说出来**。
 * 这两件事今天已经分开栽过好几次：功能在、测试绿、界面一声不响。
 *
 * 还有一层只有真浏览器能验：/estimate.js 和 /pricing.js 是两个
 * 直接发原件给浏览器的模块。它们要是 import 挂了，**整个工作台白屏**——
 * 不是少一行价钱。Node 里的自检永远看不到这一类坏法。
 */
console.log('\n钱：预估那句话在不在屏幕上');
await step('出图').click();
await page.waitForTimeout(900);
{
  const line = await page.locator('.cost-line').first().innerText().catch(() => '');
  check('出图那一步摆出了这一下要发多少', /出图\s*\d+\s*张/.test(line), line || '（一行都没有）');
  /**
   * ⚠ 没填单价时**必须说"还没填单价"，不许显示 ¥0**。
   *
   * 这是整个功能的地基：未知当 0 会得到一个看起来正常的偏小的数，
   * 而人会照着它下手。走查机上一条单价都没填，所以这里正好验到这个分支。
   */
  check('没填单价时说的是"算不出钱"，不是 ¥0',
    line.includes('还没填单价') && !/¥\s*0(\D|$)/.test(line), line);

  /**
   * ⚠ 合成那一步必须说"不花钱"，而且必须**在屏幕上**说。
   *
   * 这条是整个功能里最有价值的一句话：调节奏、换顺序、砍一镜、配段音乐，
   * 全在合成这一步里，全部是本机 FFmpeg，一分钱不花。
   * 用户不知道这件事的时候，会为了改一个节奏去重出一整轮视频。
   *
   * 金丝雀第一轮把 describe() 里那句"不花钱"删掉，走查照样全绿 ——
   * 因为它从头到尾没翻到合成那一步。功能在、自检绿、界面不说话，
   * 又是同一个病，这次犯在验收本身上。
   */
  await step('合成').click();
  await page.waitForTimeout(800);
  const composeLine = await page.locator('.cost-line').first().innerText().catch(() => '');
  check('合成那一步当面说"不花钱"', /不花钱/.test(composeLine), composeLine || '（一行都没有）');
  check('而且说清了为什么（本机 FFmpeg）', /FFmpeg|本机/.test(composeLine), composeLine);
  await step('出图').click();
  await page.waitForTimeout(700);

  // 预估摆在按钮**上面** —— 这句话是给还没按的人看的
  const order = await page.evaluate(() => {
    const c = document.querySelector('.cost-line');
    const b = document.querySelector('.stage-detail-head .btn.primary');
    if (!c || !b) return 'missing';
    return (c.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'before' : 'after';
  });
  check('它摆在「开始」按钮前面（按完再说就晚了）', order === 'before', order);
}

console.log('\n钱：这个项目花了多少');
{
  const card = page.locator('.card', { hasText: '这个项目花了多少' }).first();
  check('账那张卡在页面上', (await card.count()) > 0);
  await card.locator('summary').click().catch(() => {});
  await page.waitForTimeout(600);
  const body = await card.innerText().catch(() => '');
  check('展开后说得出这个项目发过什么', /这个项目到现在/.test(body), body.slice(0, 120));
  /**
   * 走查机跑过出图，所以账上必须有图 —— 而且必须挂着"没填单价"。
   * 只要这两条同时成立，就说明"用量记下来了、钱等你填单价"这条路是通的。
   */
  check('用量已经在账上了（哪怕一个单价都没填）', /出图/.test(body), body.slice(0, 200));
  check('并且就地给了填单价的地方', (await card.locator('.rate-row input').count()) > 0);

  // 填一个单价，钱要当场出现 —— 这是"存的是用量、钱现算"那个设计的唯一可见证据
  const first = card.locator('.rate-row input').first();
  await first.fill('0.25');
  await card.locator('button', { hasText: '存单价' }).click();
  await page.waitForTimeout(1200);
  const after = await card.innerText().catch(() => '');
  check('填完单价，钱当场算出来了（过去的账也跟着亮）',
    /¥\d/.test(after) && !/还没填单价/.test(after.split('这个项目到现在')[1] || after),
    after.slice(0, 200));
}

console.log('\n钱：全部项目一共花了多少');
await page.locator('.nav-item', { hasText: '项目' }).first().click().catch(async () => {
  await page.locator('a,button', { hasText: '项目' }).first().click();
});
await page.waitForTimeout(1200);
{
  const panel = page.locator('.panel', { hasText: '一共花了多少' }).first();
  check('项目页底下有一张跨项目的总账', (await panel.count()) > 0);
  if (await panel.count()) {
    const body = await panel.innerText();
    check('总账说得出合计', /全部项目合计|还没花过/.test(body), body.slice(0, 120));
    /**
     * 刚才在工作台上填过一个单价，所以这里必须已经出钱了 ——
     * 这一条同时验了"账本存的是用量、钱现算"：总账和单项目账
     * 读的是同一份用量，换算用的是同一张单价表。
     */
    check('工作台上填的单价，这里也算数', /¥\d/.test(body), body.slice(0, 200));
  }
}


/**
 * ══════════ 表格 / 连播 / 为什么不对 ══════════
 *
 * 这三样服务端那边都验过判据本身。这里补的是**它们有没有到屏幕上、
 * 点下去有没有反应** —— 键盘、播放、异步拉取，服务端自检一样都碰不到。
 */
console.log('\n表格 · 连播 · 为什么不对');
{
  await page.goto(`${url}#/studio/${proj.id}`);
  await page.waitForTimeout(1000);
  /**
   * ⚠ 先把**出图**跑掉。
   *
   * 「为什么不对」只在有图的镜头上出现（没图时那是另一类问题，
   * 别处在管）。不跑这一步的话，这几条验的是一个空面板 ——
   * 而空面板和"功能没做"长得一模一样。
   * 上游全是桩，这一步不花钱。
   */
  await page.locator('.nav-step', { hasText: '镜头出图' }).first().click();
  await page.waitForTimeout(600);
  const go = page.locator('.stage-detail button:has-text("开始")').first();
  if (await go.count()) {
    await go.click();
    await page.waitForFunction(() => !document.querySelector('.spin'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  await page.locator('.nav-step', { hasText: '分镜' }).first().click();
  await page.waitForTimeout(800);

  // ── 表格视图 + 键盘 ──
  await page.locator('button:has-text("表格")').first().click();
  await page.waitForTimeout(600);
  check('切得到表格视图', (await page.locator('.shot-table tbody tr').count()) > 0);
  await page.locator('.shot-table-wrap').first().focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  check('空格能选中当前那一行', (await page.locator('.shot-table tr.picked').count()) === 1,
    String(await page.locator('.shot-table tr.picked').count()));
  check('选中之后批量工具条才出现（没选时不该占地方）',
    (await page.locator('.batch-bar .batch-count').count()) === 1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  check('↑↓ 移动 + 空格能多选', (await page.locator('.shot-table tr.picked').count()) === 2,
    String(await page.locator('.shot-table tr.picked').count()));
  /**
   * ⚠ **快捷键必须在输入框里失效。**表格里有就地改时长的数字框，
   * 人在里面打字时按空格要出现空格，而不是跳着选中别的镜头。
   */
  await page.locator('.shot-table .cell-num').first().click();
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  check('在时长输入框里按空格，不会误触多选',
    (await page.locator('.shot-table tr.picked').count()) === 2,
    String(await page.locator('.shot-table tr.picked').count()));
  await page.locator('.shot-table-wrap').first().focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc 清空选择', (await page.locator('.shot-table tr.picked').count()) === 0);

  // ── 连播 ──
  await page.locator('button:has-text("连播")').first().click();
  await page.waitForTimeout(800);
  check('切得到连播', (await page.locator('.animatic .ani-stage').count()) === 1);
  const before = await page.locator('.ani-clock').first().innerText();
  await page.locator('.animatic').first().focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(1200);
  const after = await page.locator('.ani-clock').first().innerText();
  /**
   * 判据是**时间真的在走**，不是"有没有播放按钮"。
   * 按钮在、点了没反应，是这类播放器最常见的坏法。
   */
  check('空格真的开始播了（时间在走）', before !== after, `${before} → ${after}`);
  await page.keyboard.press(' ');
  check('每一镜在进度条上占一格', (await page.locator('.ani-tick').count()) > 0,
    String(await page.locator('.ani-tick').count()));

  // ── 为什么不对 ──
  await page.locator('button:has-text("卡片")').first().click();
  await page.waitForTimeout(600);
  const why = page.locator('button:has-text("为什么不对")').first();
  check('出过图的镜头卡上有「为什么不对」', (await why.count()) > 0);
  if (await why.count()) {
    await why.click();
    await page.waitForFunction(() => document.querySelector('.diag-item'), null, { timeout: 15000 }).catch(() => {});
    const txt = await page.locator('.diag-host').first().innerText();
    check('点下去给出了原因和下一步', /→/.test(txt) && txt.length > 20, txt.slice(0, 140));
  }
}

/**
 * ══════════ 在跑的时候，那颗按钮必须是「停下来」 ══════════
 *
 * 用户报的：手机上点「继续出图」，撞上一段"这个项目已经在跑（321 秒前开始）"——
 * 而那句话本身就说明这一下压根不该点得动。
 *
 * 根因：电脑版的"在不在跑"**只看页面自己内存里那个变量**，从不问服务端。
 * 刷新一次、换台设备、或者流断一次（手机锁屏就够了），按钮就亮回来，
 * 而服务器还在一镜一镜地出。
 *
 * ⚠ 判据是**在服务端登记一份活儿之后，界面自己变**，
 * 不是"有没有写轮询代码"。
 */
console.log('\n在跑的时候不该能再点一次');
{
  const jobsMod = await import(CORE('jobs.js'));
  const running = jobsMod.start(proj.id, 'assets');
  await page.goto(`${url}#/studio/${proj.id}`);
  await page.waitForTimeout(1500);
  await page.locator('.nav-step', { hasText: '镜头出图' }).first().click();
  await page.waitForTimeout(1500);

  const stopBtn = page.locator('.stage-detail button:has-text("停下来")');
  // 轮询是四秒一次，等它自己变 —— 判据是"界面最终会自己反应过来"
  await page.waitForSelector('.stage-detail button:has-text("停下来")', { timeout: 15000 }).catch(() => {});
  check('服务端在跑时，主按钮变成「停下来」', (await stopBtn.count()) > 0);
  check('而且「开始/继续」不在了（不是变灰，是换了个动作）',
    (await page.locator('.stage-detail button:has-text("开始")').count()) === 0
    && (await page.locator('.stage-detail button:has-text("继续")').count()) === 0);
  const head = await page.locator('.stage-detail-head').first().innerText();
  /** 进度要来自服务端 —— 页面自己记的那份一刷新就没了 */
  check('说得出在跑哪一步、跑了多久', /中 ·? ?已跑 \d+ 秒|已跑 \d+ 秒/.test(head), head.slice(0, 160));

  jobsMod.finish(running);
  await page.waitForTimeout(5000);
  check('跑完之后按钮自己变回「开始」（不用手动刷新）',
    (await page.locator('.stage-detail button:has-text("停下来")').count()) === 0
    && (await page.locator('.stage-detail button:has-text("开始"), .stage-detail button:has-text("继续")').count()) > 0);
}

/**
 * ══════════ 镜头卡：出处与排查折起来了 ══════════
 *
 * 用户："卡片下面的功能都太杂太乱了"。
 * ⚠ 这几条守的是**克制** —— 下次再有人往卡面上摊一块信息，这里会红。
 */
/**
 * ══════════ 指令框 ══════════
 *
 * ⚠ 这一节必须**真的往框里打字**，不能只验"元素在不在"。
 *
 * 这个框的价值全在"执行前先摆出要做什么"那一步 —— 而那一步是
 * 输入 → 请求 → 预览 → 按钮变样这一整条链。链上任何一环断了，
 * 页面都不会报错，框还在，只是永远不出预览。
 * 只验元素存在的话，那种断法一次都抓不到。
 */
console.log('\n指令框：打进去要能看见它理解成了什么');
{
  await page.goto(`${url}#/studio/${proj.id}`);
  await page.waitForTimeout(1000);
  await page.locator('.nav-step', { hasText: '镜头出图' }).first().click();
  await page.waitForTimeout(900);

  const input = page.locator('.cmd-input').first();
  check('指令框在', (await input.count()) === 1);

  await input.fill('第 1-3 镜改成中景');
  // 250ms 防抖 + 一次请求
  await page.waitForTimeout(1200);
  const prev = page.locator('.cmd-preview').first();
  const said = (await prev.textContent()) || '';
  check(`预览说清楚了要做什么（${said.slice(0, 40)}）`, /景别/.test(said) && /中景/.test(said));
  check('预览里带了镜数，不是光说"改一批"', /\d+\s*镜/.test(said));
  /** 改文字不花钱 —— 不该被标成要花钱那一档，否则用户每次都被吓一下 */
  check('免费的动作不标成花钱', !(await prev.getAttribute('class') || '').includes('costly'));

  const btn = page.locator('.cmd-box button').first();
  check('执行按钮上写的是这次动几镜，不是"确定"', /镜/.test((await btn.textContent()) || ''));
  check('而且是可按的', !(await btn.isDisabled()));

  // ── 花钱的那一类要变色 ──
  await input.fill('把缺视频的都跑了');
  await page.waitForTimeout(1200);
  check('要花钱的动作，预览换成警示色',
    ((await prev.getAttribute('class')) || '').includes('costly'));
  check('并且说明按下去只是跳过去，还要再过一遍预检',
    /预检|估算/.test((await prev.textContent()) || ''));

  // ── 看不懂时不许装懂 ──
  await input.fill('哦豁');
  await page.waitForTimeout(1200);
  check('看不懂时说看不懂', ((await prev.getAttribute('class')) || '').includes('bad'));
  check('按钮变成不可按（绝不让它执行一个没听懂的指令）',
    await page.locator('.cmd-box button').first().isDisabled());
  check('并且给了能直接点的例子', (await page.locator('.cmd-eg-btn').count()) > 0);
  /**
   * 例子是可点的模板，不是装饰。
   *
   * ⚠ 而且例子里的镜号必须取自**这个项目** —— 第一版写死了"第 6-12 镜"，
   * 而走查夹具只有 2 镜，点下去选不到任何东西。用户第一次点例子就撞墙，
   * 那是他对这个功能的第一印象。这条断言就是在那儿撞出来的。
   */
  const egText = (await page.locator('.cmd-eg-btn').allTextContents()).join(' ');
  const shotCount = await page.locator('.shot-card').count();
  /**
   * ⚠ 抓**所有**数字，不是"第"后面那一个。
   * 第一版写的是 /第\s*(\d+)/，而"第 1-3 镜"里它只抓得到 1 ——
   * 于是这条断言碰巧过了，而真正越界的那个 3 从来没被看过。
   * 一条只检查一半的断言，绿着也只是绿着。
   */
  const nums = [...egText.matchAll(/\d+/g)].map((m) => Number(m[0]));
  const tooBig = nums.filter((n) => n > shotCount);
  check(`例子里的镜号都在这 ${shotCount} 镜之内（例子：${egText.slice(0, 40)}）`, tooBig.length === 0);
  await page.locator('.cmd-eg-btn').first().click();
  await page.waitForTimeout(1200);
  check('点一下例子就填进去了，而且解析得出来',
    !((await prev.getAttribute('class')) || '').includes('bad'));
}

console.log('\n镜头卡的分层');
{
  /**
   * ⚠ 要在**出过图**的那一步验。
   *
   * 分镜那一步还没有出处可言（没参考图、没模型、没首帧核对），
   * 折叠区本来就该整个不存在 —— 拿那一步来验，验的是空气。
   * 第一版就是这么写的，跑出来"折叠区里有：空字符串"。
   */
  await page.goto(`${url}#/studio/${proj.id}`);
  await page.waitForTimeout(1000);
  await page.locator('.nav-step', { hasText: '镜头出图' }).first().click();
  await page.waitForTimeout(900);
  const card = page.locator('.shot-card').first();
  const more = card.locator('details.shot-more').first();
  check('排查用的那一段收进了折叠区', (await more.count()) === 1);
  check('默认是折起来的', (await more.evaluate((el) => el.open)) === false);
  /**
   * ⚠ 折起来 ≠ 删掉 —— 点开必须一样都不少。
   * 展开本身是浏览器原生的 <details>，不是我们的代码，所以直接置 open：
   * 这一节要验的是**内容分对了组**，不是原生行为能不能触发。
   */
  await more.evaluate((el) => { el.open = true; });
  await page.waitForTimeout(200);
  // ⚠ 用 textContent 不用 innerText：后者对没渲染出来的区域返回空串，
  // 于是内容在不在会被读成没有内容—— 而那是两回事
  const inner = await more.evaluate((el) => el.textContent);
  check('点开之后参考图那行还在',
    /参考图|张图可以带|还没有图|早前出的|没有图可带/.test(inner), inner.slice(0, 100));
  check('提示词原文也还在', /提示词|发给模型|手动补入/.test(inner), inner.slice(0, 200));
  /** 徽章留在外面：那是"这一镜是什么"，扫一眼就要看到，不是排查用的 */
  const meta = card.locator('.shot-meta').first();
  check('景别/场景那些徽章仍然摆在外面（扫一眼就要看到）',
    (await meta.count()) === 1 && (await meta.evaluate((el) => !el.closest('details'))));

  /**
   * ⚠ **折叠区在的时候，里面必须真的有东西。**
   *
   * 第一版把这条写成了"分镜那一步不该有折叠区"—— 那是错的：
   * 那时候里面有「发给模型的提示词」，是有意义的内容。
   * 真正的不变量不是"某一步没有"，而是**永远不出现一个点开是空的折叠区**。
   * 一个点开什么都没有的「出处与排查」，比多几行字更让人觉得这界面不靠谱。
   */
  await page.locator('.nav-step', { hasText: '分镜' }).first().click();
  await page.waitForTimeout(800);
  const emptyFolds = await page.evaluate(() =>
    [...document.querySelectorAll('details.shot-more')]
      .filter((d) => {
        const sm = d.querySelector(':scope > summary');
        return d.textContent.replace(sm ? sm.textContent : '', '').trim().length === 0;
      }).length);
  check('没有一个折叠区是点开就空的', emptyFolds === 0, `空的有 ${emptyFolds} 个`);
}


check('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(bad ? `\n\x1b[31m${bad} 项没过\x1b[0m` : '\n\x1b[32m界面走查全过\x1b[0m');
process.exit(bad ? 1 : 0);
