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
import { fileURLToPath } from 'node:url';
import os from 'node:os';
/**
 * ══════════ 汇总行 ══════════
 *
 * ⚠ 这一节是被一次真实的误读逼出来的。
 *
 * mcheck 原来只逐条打 ✓/✕，**没有汇总**。而另外三层都有一句
 *「全部通过：N 项」。于是判据在这一层变成了"翻一遍输出自己数"——
 * 而实际发生的是：只看了 `tail -2`（页面报错那一行），
 * 两条早就红了的断言躺了整整一轮没人发现。
 *
 * 这和这个项目里反复强调的那条是同一件事：**判据必须是
 * "有没有打出全过"，不是"我数了几个 ✕"**。人会数错，也会不数。
 *
 * 做法是拦 console.log 统计，而不是把几十处 ternary 全改一遍 ——
 * 改几十处的风险比这一小段拦截大得多。
 */
let mFail = 0;
let mPass = 0;
{
  const raw = console.log.bind(console);
  console.log = (...args) => {
    const line = args.join(' ');
    if (line.includes('✕')) mFail += 1;
    else if (line.includes('✓')) mPass += 1;
    raw(...args);
  };
  process.on('exit', () => {
    raw('\n' + '─'.repeat(50));
    raw(mFail ? `手机走查 ${mFail} 项未通过（通过 ${mPass} 项）` : `手机走查全过：${mPass} 项`);
  });
}

const rejections = [];

/**
 * 关掉所有抽屉。
 *
 * ⚠ 点 `.sheet` 的边角是关不掉的 —— openSheet 只在 `e.target === layer`
 * 时关，而点到 (5,5) 往往落在里面的 `.sheet-box` 上。留一张开着的抽屉
 * 会把**后面每一节**都挡住，然后报成"页签点不到"，查半天在查别的事。
 */
const closeSheets = (pg) => pg.evaluate(() => {
  // 编辑器是 .ed（自己挂在 body 上的一层），不是 .sheet —— 两种都要收
  for (const el of document.querySelectorAll('.sheet, .ed')) el.remove();
});

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
let chromium; let devices;
try {
  const mod = await import(PW);
  // 全局装的那份是 CommonJS，`import` 进来时命名导出认不出来，全在 default 上
  chromium = mod.chromium || mod.default?.chromium;
  devices = mod.devices || mod.default?.devices;
  if (!chromium) throw new Error('这份 Playwright 里没有 chromium');
} catch {
  console.error(
    '没找到 Playwright。先装一下：npm i -g playwright && npx playwright install chromium\n' +
    '或者设 PLAYWRIGHT_PATH 指向已经装好的那份 index.mjs。'
  );
  process.exit(2);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-m-'));
process.env.FUTUREDREAM_DATA_DIR = SANDBOX;

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
const store = await import(CORE('store.js'));
const srv = await import(CORE('server.js'));

settings.patch({ autoCheckOnStart: false });
const proj = store.create({ title: '手机端测试', aspectRatio: '9:16', script: '阿澜在码头巡查。' });
/**
 * 用**真文件**做素材，不是编几个路径。
 * 媒体接口只放行数据目录之内的文件，而手机端的图和视频靠查询串带配对码 ——
 * 拿假路径测的话，这条最容易坏的链路（图打不开）根本测不到。
 */
const assetDir = store.assetDir(proj.id);
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const asset = (name, buf = PIXEL) => {
  const f = path.join(assetDir, name);
  fs.writeFileSync(f, buf);
  return f;
};
store.update(proj.id, (p) => {
  p.bible = { style: { anchor: '国风', negative: '' },
    // 参考图也用**真文件**：设定集那一页要渲染它的缩略图，
    // 用假路径的话媒体接口一律 403，而"图裂了"正是这条链路最常坏的样子
    characters: [{ name: '阿澜', appearance: '短发', seed: 1,
      variants: [{ id: 'v-default', name: '默认造型', sheetPath: asset('sheet-alan.png') }],
      sheetPath: asset('sheet-alan.png') }],
    // 两个场景：场地图那一节要能把它们摆到一张图上，一个是摆不出关系的
    scenes: [
      { name: '栈桥', appearance: '伸进雾里的木栈桥' },
      { name: '灯塔下', appearance: '锈迹斑斑的灯塔基座' }
    ],
    props: [] };
  p.shots = [
    { id: 's1', index: 1, characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景', dialogue: '设备正常。', speaker: '阿澜', duration: 4, consistency: { score: 88, pass: true }, videoPath: asset('v1.mp4'), audioPath: asset('a1.mp3'), imagePath: asset('i1.png') },
    // 第二镜**只有图、还没出视频** —— 这是"出图完、视频还没跑"时的常态，
    // 也是唯一能验"点图放大"那条路的状态（视频有原生控件，不该被拦）
    { id: 's2', index: 2, characters: ['阿澜'], description: '阿澜蹲下查看缆绳', camera: '特写', dialogue: '', duration: 3, imagePath: asset('i2.png') }
  ];
  p.outputs = {
    video: asset('final.mp4'),
    subtitle: asset('final.srt', Buffer.from('1\n00:00:00,000 --> 00:00:03,850\n设备正常。\n')),
    seconds: 7,
    durationPolicy: 'trim'
  };
  p.stageStatus = { ...p.stageStatus, bible: 'done', script: 'done' };
  return p;
});

/**
 * 账本里先种几笔用量。
 *
 * ⚠ 这台走查机**不联网**，上面那些图和视频是直接写进磁盘的，
 * 流水线一次都没真跑过 —— 所以账本天然是空的，而空账本只能验到
 * "还没花过"那一支。真正要看的是另外两支：用量摊开、以及
 * "没填单价"时能不能就地填。所以这里按真实形状补几笔。
 *
 * 种的是**用量**不是钱 —— 账本本来就只存用量，这也顺带验了那件事：
 * 种完之后一个单价都没有，卡片上必须显示用量、并且挂着"还没填单价"。
 */
const ledgerM = await import(CORE('ledger.js'));
ledgerM.add({ projectId: proj.id, stage: 'assets', provider: 'volcengine', model: 'doubao-seedream-3-0-t2i-250415', kind: 'image', units: 1 });
ledgerM.add({ projectId: proj.id, stage: 'assets', provider: 'volcengine', model: 'doubao-seedream-3-0-t2i-250415', kind: 'image', units: 1 });
ledgerM.add({ projectId: proj.id, stage: 'video', provider: 'volcengine', model: 'doubao-seedance-1-0-pro-250528', kind: 'video', units: 10 });
ledgerM.flush();

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
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
/**
 * 盯着所有 4xx。
 *
 * 加这一条是因为踩过一次：手机端画风缩略图整排 401（<img> 带不了鉴权头），
 * 页面看着"只是图没加载出来"，功能检查全绿 —— 而实际上那一整块是坏的。
 * 有意为之的拒绝（下面第 ⑧ 步专门验"不带码要被挡住"）会被 expect401 放行。
 */
let expect401 = false;
const unexpected4xx = [];
page.on('response', (r) => {
  if (r.status() < 400 || expect401) return;
  unexpected4xx.push(`${r.status()} ${new URL(r.url()).pathname}`);
});
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
/**
 * ⚠ async 函数里抛出的错**不会**变成 pageerror，它是 unhandledrejection。
 *
 * 这条护栏是拿一个真 bug 换来的：openWhy 是 async，里面一个
 * `add is not defined`（那个函数只存在于电脑端 lib.js）让手机上
 * 「看看为什么」整颗按钮失效了一整轮，而走查全绿 —— 因为只监听 pageerror。
 */
await page.addInitScript(() => {
  window.addEventListener('unhandledrejection', (e) => {
    (window.__fdRejections ||= []).push(String(e.reason?.message || e.reason));
  });
});
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

// ①② 这两步是**故意**不带码 / 带错码的，那些 401 是预期结果
expect401 = true;
// ① 不带码打开 → 应该看到配对屏
await page.goto(`${base}/m`);
await page.waitForTimeout(1200);
console.log('\n① 不带码打开：', /配对码/.test(await page.locator('#app').innerText()) ? '显示配对屏 ✓' : '✕');

// ② 敲错的码
await page.locator('input').fill('WRONGKEY');
await page.locator('button:has-text("连接")').click();
await page.waitForTimeout(900);
console.log('② 敲错的码：', /配对码不对/.test(await page.locator('body').innerText()) ? '当场说清楚 ✓' : '✕');

// 预期内的 401 到此为止 —— 不复位的话这条检查就永远是绿的，等于没测
expect401 = false;

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

/**
 * ⑤ 改这一镜。
 *
 * 审片的完整回路是"看到不对 → 改一句 → 重出"，缺了中间那步等于白看。
 * 早先只放开描述和时长，理由是"别的在手机上改起来慢"—— 那个判断是错的：
 * 最常当场想改的恰恰是台词和谁说的，一眼看得出不对，改起来也只是敲几个字。
 */
/**
 * ⚠ 走的是**点描述**这条路，不是那颗按钮。
 *
 * 卡片按"你什么时候需要它"分了三层，「改这一镜」收进了折叠的详情区。
 * 而改文案是审片时最高频的动作 —— 所以描述本身就能点。
 * 这条断言守的正是那件事：**高频路径没有多一次点击**。
 */
await page.locator('.shot-desc.tappable').first().click();
await page.waitForTimeout(400);
/**
 * 编辑是**整屏一层**（.ed），不再是卡片里就地展开的手风琴。
 * 手风琴那版的毛病：十二个字段一展开，滚到第七个时屏幕上已经没有
 * 任何东西写着"你在改第几镜"了 —— 而这一页最常见的用法就是连着改好几镜。
 */
const ed = page.locator('.ed');
console.log('   整屏面板打开了：', (await ed.count()) === 1 ? '✓' : '✕ 还是卡片里展开的');
console.log('   顶上一直写着在改第几镜：',
  /第 1 镜/.test(await ed.locator('.ed-top').innerText().catch(() => '')) ? '✓' : '✕');
await ed.locator('.ed-body textarea').nth(0).fill('阿澜停在栈桥尽头远眺');
await ed.locator('.ed-body textarea').nth(1).fill('这里的缆绳被人动过。');
await ed.locator('.ed-body select').first().selectOption('阿澜');
// 景别在「镜头」那一组 —— 分组本身就是这次要验的东西
await ed.locator('.ed-tab:has-text("镜头")').click();
await page.waitForTimeout(250);
await ed.locator('.chip:has-text("全景")').click();
await ed.locator('.ed-top button:has-text("保存")').click();
await page.waitForTimeout(1200);
console.log('   存完就退出去了：', (await page.locator('.ed').count()) === 0 ? '✓' : '✕ 还挡在上面');
const saved = store.read(proj.id).shots.find((x) => x.id === 's1');
console.log('⑤ 手机上改这一镜：');
console.log('   描述：', saved.description === '阿澜停在栈桥尽头远眺' ? '存下了 ✓' : `✕ ${saved.description}`);
console.log('   台词：', saved.dialogue === '这里的缆绳被人动过。' ? '存下了 ✓' : `✕ ${saved.dialogue}`);
console.log('   谁说的：', saved.speaker === '阿澜' ? '存下了 ✓' : `✕ ${saved.speaker}`);
console.log('   景别：', saved.camera === '全景' ? '存下了 ✓' : `✕ ${saved.camera}`);

/**
 * ⑤a 预演台。
 *
 * 这一块的**画布和几何是和电脑版共用同一份代码**（ui/previz-canvas.js
 * + core/pipeline/previz.js，后者按 /previz.js 原样发给浏览器）。
 * 所以这里验的是"手机这一端接得上没有"：
 *   · 那两个根路径上的模块在手机那条监听上放行了吗
 *     —— 不放行会 401，而 import 失败会让**整个 m.js 加载不起来**，
 *        表现是打开一片空白，连输配对码那一屏都没有（真踩过）
 *   · 折叠面板点开后画布画出来了吗、读数出来了吗
 *
 * 拖动本身在电脑版那条走查里真拖过（uicheck），是同一段代码，这里不重复。
 */
await page.locator('.tab', { hasText: '分镜' }).click();
await page.waitForTimeout(600);
/**
 * 从**卡片上那个按钮**点起，走用户真正会走的那条路。
 * 原来它只藏在「改这一镜」里面往下翻很远的地方 —— 用户的原话是"没找到"。
 */
await page.locator('.shot .iconbtn').first().click();
await page.waitForTimeout(400);
const sheet = page.locator('.acts-sheet');
console.log('⑤a 卡片上那个「⋯」打得开：', (await sheet.count()) === 1 ? '✓' : '✕ 打不开');
const entry = sheet.locator('.row-act:has-text("预演台")');
const hasEntry = (await entry.count()) > 0;
console.log('   面板里有预演台：', hasEntry ? '✓' : '✕ 找不到');
if (hasEntry) {
  await entry.click();
  await page.waitForTimeout(900);
}
// 从「⋯ → 预演台」进来，应该**直接落在预演台那一组**，不是落在内容组让人自己翻
console.log('   直接落在预演台那一组：',
  (await page.locator('.ed-tab.on:has-text("预演台")').count()) === 1 ? '✓' : '✕ 还要自己点');
console.log('   画布：', (await page.locator('.previz-canvas').count()) > 0 ? '画出来了 ✓' : '✕');
console.log('   读数：', /mm/.test(await page.locator('.previz-line-text').first().innerText().catch(() => '')) ? '有 ✓' : '✕');
await page.locator('.ed-top button:has-text("取消")').click();
await page.waitForTimeout(300);

/**
 * ⑤a2 筛选条。
 *
 * 十二镜里有三镜有毛病时，让人一镜一镜翻过去找，等于把机器该干的事推给人 ——
 * 而手机上一屏只看得见一两镜，翻的代价还要再高一截。
 * 这份数据里第 2 镜是故意没出视频的，所以「缺视频」那一档必须出现，
 * 点下去必须真的只剩它。
 */
const chips = await page.locator('.filterbar .fchip').allInnerTexts();
console.log('⑤a2 筛选条：', chips.join(' | '));
const novideo = page.locator('.filterbar .fchip:has-text("缺视频")');
if ((await novideo.count()) > 0) {
  await novideo.click();
  await page.waitForTimeout(500);
  const left = await page.locator('.shot').count();
  console.log('   点「缺视频」只剩那一镜：', left === 1 ? '✓' : `✕ 还剩 ${left} 张`);
  console.log('   那一镜身上有问题条：',
    (await page.locator('.shot .prob').count()) >= 1 ? '✓' : '✕ 卡上不说哪儿不对');
  /**
   * ⚠ 这一条在卡片改成三层之后**过时了**，而当时没发现 ——
   * 因为看的是 `tail -2`（页面报错那一行），而 mcheck 没有汇总行，
   * 它是逐条打 ✓/✕ 的。判据错了，一条真红的断言就这么躺了一轮。
   *
   * 新设计里「重出」不在卡面上：卡面只有一颗主按钮「看看为什么」，
   * 重出排在抽屉里那些原因**下面**——因为它们是先后关系不是并列。
   * 所以这里验的是"卡面那颗主按钮是该按的那个"，
   * 而重出按钮由 ⑭ 那一节在抽屉里验。
   */
  console.log('   主按钮就是该按的那个：',
    /看看为什么/.test(await page.locator('.shot .btn.primary').first().innerText().catch(() => '')) ? '✓' : '✕');
  await page.locator('.filterbar .fchip:has-text("全部")').click();
  await page.waitForTimeout(400);
} else {
  console.log('   ✕ 有一镜没视频，筛选条里却没有「缺视频」这一档');
}

// ⑤b 剧本和设定集：这两样以前只能"回电脑上改"，现在手机上就能改
await page.locator('.tab', { hasText: '剧本' }).click();
await page.waitForTimeout(600);
await page.locator('.card textarea').first().fill('阿澜在码头巡查，发现缆绳被割断。她想起三天前的那通电话。');
await page.locator('button:has-text("保存剧本")').click();
await page.waitForTimeout(1000);
console.log('⑤b 手机上改剧本：',
  /三天前的那通电话/.test(store.read(proj.id).script) ? '存下了 ✓' : '✕');
console.log('   画风也能选：', (await page.locator('.style-mini-card').count()) > 3 ? '✓' : '✕');

/**
 * ══════════ 大纲（手机端） ══════════
 *
 * ⚠ 这一节是**零覆盖**补上的：大纲在能力清单里登记着、两端代码都在、
 * 电脑端走查从头到尾验过一遍 —— 而手机端一个字都没验过。
 * 而"改大纲最常发生在手机上"正是当初把它做到手机端的理由。
 * 用得最多的那一端没人验，这个组合迟早出事。
 *
 * ⚠ 验的是**画得出来**，不是**生成得出来**。
 *
 * mcheck 整套不打模型的桩（不像 uicheck），所以在这儿点「生成大纲」
 * 必然拿不到场次 —— 那是夹具的边界，不是功能坏了。
 * 第一版就是这么写的，红了之后差点被当成产品 bug 报出去。
 *
 * 所以这里直接把一份大纲塞进项目，验手机端**渲染**那一半：
 * 那正好是"服务端拆出来了、手机上却是空的"这类问题会出现的地方。
 */
{
  const seeded = store.read(proj.id);
  seeded.outline = {
    beats: [
      { id: 'b-01', scene: '码头', time: '清晨', characters: ['阿澜'], summary: '阿澜走向栈桥', dialogue: '设备正常。', seconds: 20 },
      { id: 'b-02', scene: '码头', time: '清晨', characters: ['阿澜'], summary: '发现缆绳被割断', dialogue: '割口是新的。', seconds: 25 },
      { id: 'b-03', scene: '栈桥', time: '清晨', characters: ['阿澜'], summary: '望向雾里的灯塔', dialogue: '', seconds: 12 }
    ],
    updatedAt: new Date().toISOString()
  };
  store.save(seeded);
  await page.reload();
  await page.waitForTimeout(1200);
  await page.locator('.tab', { hasText: '剧本' }).click();
  await page.waitForTimeout(900);

  console.log('   剧本页上有大纲这一块：',
    (await page.locator('button:has-text("从剧本生成大纲")').count()) > 0 ? '✓' : '✕ 手机上根本看不到大纲');
  /**
   * ⚠ 手机端有**自己的**一套 class（mob-row / mob-floor），
   * 不是电脑端那套（ob-row / ob-floor）。第一版照抄了电脑端的选择器，
   * 于是"画出 0 行"——而页面上内容明明在。差点又报一个假 bug。
   */
  const rows = await page.locator('.mob-row').count();
  console.log('   已有的大纲画得出来：', rows >= 3 ? `✓ ${rows} 行` : `✕ 只画出 ${rows} 行（存着 3 场）`);
  const txt = await page.locator('#app').evaluate((el) => el.textContent || '');
  console.log('   每一场的内容也在：', /缆绳被割断/.test(txt) ? '✓' : '✕ 行画出来了但内容是空的');
  /** 台词的硬下限和"节奏偏长"是两回事：前者除非删台词否则压不下去 */
  console.log('   有台词的场次标出了念完要多久：',
    (await page.locator('.mob-floor').count()) > 0 ? '✓' : '✕');
}
// <img> 带不了鉴权头 —— 漏了口令的话整排缩略图 401，显示成一片空框，
// 而"图裂了"最容易被当成图片本身有问题
const broken = await page.locator('.style-mini-card img').evaluateAll(
  (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length);
console.log('   缩略图有没有裂：', broken === 0 ? '都正常 ✓' : `✕ ${broken} 张裂了`);

await page.locator('.tab', { hasText: '设定' }).click();
await page.waitForTimeout(700);
await page.locator('.card textarea').first().fill('短发，藏青立领制服，左眉有疤');
await page.locator('button:has-text("保存描述")').first().click();
await page.waitForTimeout(1000);
const who = store.read(proj.id).bible.characters[0];
console.log('⑤c 手机上改设定集：', /左眉有疤/.test(who.appearance || '') ? '存下了 ✓' : `✕ ${who.appearance}`);

/**
 * ⑤d 点开看大图。
 *
 * 审片时最需要的动作就是放大 —— 而页面头上 user-scalable=no 把系统缩放
 * 关掉了（不关的话点输入框会把整页放大且退不回去），所以这一层是自己做的，
 * 也就必须自己测：打不开、关不掉、放大后拖没了，都是真会发生的事。
 */
await page.locator('.tab', { hasText: '分镜' }).click();
await page.waitForTimeout(700);
// 只有图片能点开 —— 视频有原生控件，拦它反而挡住播放
await page.locator('img.shot-media').first().click();
await page.waitForTimeout(400);
const opened = await page.locator('.viewer').count();
console.log('⑤d 点图能放大看：', opened === 1 ? '打开了 ✓' : '✕ 没打开');
if (opened) {
  const box = await page.locator('.viewer-img').boundingBox();
  // 双击放大：变换加上去之后，元素的实际占地必须变大
  await page.locator('.viewer-img').dblclick();
  await page.waitForTimeout(350);
  const zoomed = await page.locator('.viewer-img').boundingBox();
  console.log('   双击放大：', zoomed.width > box.width * 1.5 ? `✓ ${Math.round(zoomed.width / box.width * 10) / 10}×` : '✕ 没变大');
  await page.locator('.viewer-x').click();
  await page.waitForTimeout(300);
  console.log('   关得掉：', (await page.locator('.viewer').count()) === 0 ? '✓' : '✕ 关不掉');
  // 关不掉比打不开更糟：整个界面被一层黑挡住，只能杀掉重开
  console.log('   关掉后页面能滚：', (await page.evaluate(() => document.body.style.overflow)) === '' ? '✓' : '✕ 还锁着');
}

/**
 * ⑤e 切屏回来，那份还在跑的活儿要接得回来。
 *
 * 用户的原话：「点击全跑了，手机切屏一会回来刷屏还是不动」。
 * 这份活儿跑在服务器上，切屏只是把那条进度流掐了 —— 而这一端原来
 * **从来不问一句"还在跑吗"**，于是回来看到的是一个静止的页面：
 * 进度条停在原处，没有转圈，什么都没有。人只能判断成卡死了，
 * 再点一次「往后全跑」，撞上 409 —— 而那个 409 又只显示成"HTTP 409"。
 *
 * 这里直接往登记表里塞一份活儿（它和这台服务器在同一个进程里），
 * 然后刷新页面 —— 走的正是用户切屏回来那条路。
 */
const jobs = await import(CORE('jobs.js'));
{
  const cur = store.list()[0];
  const fake = jobs.start(cur.id, 'video');
  fake.note = '第 2 镜出视频…';
  const target = store.read(cur.id).shots[1];
  fake.shotId = target.id;
  fake.shotIndex = target.index;

  await page.reload();
  await page.waitForTimeout(1600);
  const live = await page.locator('.live').innerText().catch(() => '');
  console.log('⑤e 刷新之后还认得那份在跑的活儿：', /出视频|视频生成/.test(live) ? '✓' : `✕ ${live.slice(0, 60)}`);
  console.log('   并且说得出跑到第几镜：', /第 2 镜/.test(live) ? '✓' : `✕ ${live.slice(0, 60)}`);
  console.log('   还给得出「停下来」：', /停在这一镜之后/.test(live) ? '✓' : `✕ ${live.slice(0, 80)}`);

  await page.locator('.tab', { hasText: '分镜' }).click();
  await page.waitForTimeout(700);
  console.log('   分镜页上把那一镜点亮了：',
    (await page.locator('.shot.live-shot').count()) === 1 ? '✓' : '✕ 分不出轮到哪一镜');

  /**
   * 接回来之后，那几个「开始 / 继续 / 往后全跑」必须是**灰的**。
   *
   * 这比"点下去给一句好话"更靠前一步：用户之所以会重复点，就是因为
   * 页面看起来什么也没发生。知道它在跑之后，按钮本来就不该还能按 ——
   * 409 那句人话是留给真正的竞态的（两台设备、或者轮询还没落地）。
   */
  await page.locator('.tab', { hasText: '流水线' }).click();
  await page.waitForTimeout(700);
  const runBtns = page.locator('.step button');
  const total = await runBtns.count();
  let enabled = 0;
  for (let i = 0; i < total; i += 1) if (await runBtns.nth(i).isEnabled()) enabled += 1;
  console.log('   跑着的时候那些「跑」按钮是灰的：',
    total > 0 && enabled === 0 ? `✓（${total} 个全灰）` : `✕ 还有 ${enabled} 个能点`);

  jobs.finish(fake);
  await page.reload();
  await page.waitForTimeout(1200);
}

// ⑥ 成片 + 交给剪映的素材
await page.locator('.tab', { hasText: '成片' }).click();
await page.waitForTimeout(700);
const filmText = await page.locator('#app').innerText();
console.log('⑥ 成片页：', /成片 mp4/.test(filmText) ? '有成片 ✓' : '✕');
console.log('   字幕：', /字幕 \.srt/.test(filmText) ? '✓' : '✕');
/**
 * 出了视频的镜要列出来；**没出的那几镜要点名说缺**。
 *
 * 这一条原来写的是"第 1 镜和第 2 镜都要在"，而这份数据里第 2 镜是
 * **故意没出视频**的（上面 shots 那儿写着为什么）。也就是说它从写下来
 * 那天起就是红的 —— 一条永远红的检查等于没有检查，跑的人扫一眼就跳过去了。
 *
 * 而它红着的这段时间里，真正的毛病没人发现：少一镜的素材包看起来和齐了的
 * 一模一样，人拖进剪映排完才发现中间缺一段。现在断言改成量这件事。
 */
console.log('   出了视频的镜列出来了：', /第 1 镜/.test(filmText) ? '✓' : '✕');
console.log('   没出视频的镜点名说缺：',
  /第 2 镜还没出视频/.test(filmText) ? '✓' : '✕ 素材包缺一镜却不说，进剪映才会发现');
console.log('   配音轨：', /配音/.test(filmText) ? '✓' : '✕');
const saveBtns = await page.locator('a:has-text("存到手机")').count();
console.log('   可一键存的素材数：', saveBtns, saveBtns >= 4 ? '✓' : '✕');

// ⑦ 项目切换
console.log('⑦ 单个项目时不摆下拉：', (await page.locator('.top-pick').count()) === 0 ? '✓' : '✕（多余的控件）');

/**
 * ⑧a 缺视频的那几镜，流水线页上**必须说话** —— 哪怕一个都捞不回来。
 *
 * 上一版只在"有可捞的"时候才画那张卡。用户于是对着一个什么都没有的
 * 流水线页问："在哪，在哪捞回来" —— 而正确答案是"没有可捞的"。
 * 可"没有卡"和"这个功能还没更新上"长得一模一样，他没办法分辨。
 *
 * 所以这里量的是**空的时候也出声**：这份数据里第 2 镜没视频、
 * 也没有待认领、也没有失败记录 —— 三种处境里最容易被读成"坏了"的那种。
 */
{
  await page.locator('.tab', { hasText: '流水线' }).click();
  await page.waitForTimeout(700);
  const flow = await page.locator('.body').innerText();
  console.log('⑧a 缺视频时流水线页出声：', /还差 1 镜没有视频/.test(flow) ? '✓' : `✕ ${flow.slice(0, 120)}`);
  console.log('   三种处境分开列：',
    /钱花了没取回来 0 镜/.test(flow) && /出视频失败了 0 镜/.test(flow) && /还没跑到 1 镜/.test(flow)
      ? '✓' : `✕ ${flow.slice(0, 200)}`);
  // "没有可捞的"要**明说**，不能靠没有按钮来暗示
  console.log('   明说没有可以免费捞的：',
    /没有"可以免费捞回来"的镜头|没有这一类/.test(flow) ? '✓' : '✕ 只能靠"没按钮"去猜');
  console.log('   老项目那句提醒也在：',
    /失败原因是新版才开始记的/.test(flow) ? '✓' : '✕ 会把"跑过但失败"读成"还没跑到"');

  // 反面：真有待认领时，那个免费按钮要出现
  store.update(proj.id, (p) => {
    const t = p.shots.find((x) => x.id === 's2');
    if (t) t.pendingTask = { taskId: 'task-77', provider: 'metaso', at: new Date().toISOString() };
    return p;
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const withOwed = await page.locator('.body').innerText();
  /**
   * 上一次跑的结果要**留在页面上**。
   *
   * 用户的原话："我切屏幕返回看到还是生成视频没动这个bug"。
   * 那一次其实早就跑完了 —— 只是跑完的结果没有留下来，切屏回来看到的是
   * 一个静止的流水线：4/12，没有转圈、没有报错、没有任何痕迹。
   * 进度流是给"正在看着"的人用的，这一条是给**回来的人**用的。
   */
  store.update(proj.id, (p) => {
    p.lastRun = {
      stage: 'video', stageLabel: '视频生成', outcome: 'done',
      at: new Date().toISOString(), failed: 8, message: ''
    };
    return p;
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const lastText = await page.locator('.body').innerText();
  console.log('   切回来看得到上次跑的结果：',
    /上次跑「视频生成」/.test(lastText) ? '✓' : '✕ 页面上没有任何痕迹说明跑过');
  console.log('   并且说清楚败了几镜：',
    /8 镜失败/.test(lastText) ? '✓' : `✕ ${lastText.slice(0, 100)}`);
  store.update(proj.id, (p) => { delete p.lastRun; return p; });

  console.log('   有待认领时才出免费按钮：',
    /钱花了没取回来 1 镜/.test(withOwed)
    && (await page.locator('button:has-text("捞回来")').count()) === 1 ? '✓' : '✕');
  store.update(proj.id, (p) => {
    const t = p.shots.find((x) => x.id === 's2');
    if (t) delete t.pendingTask;
    return p;
  });
  await page.reload();
  await page.waitForTimeout(1200);
}

/**
 * ⑦b 新建项目 —— **在已经有项目的时候**也点得到。
 *
 * 原来"新建"只存在于那张空状态卡片里，只有一个项目都没有时才画。
 * 也就是说建完第一部片子之后，手机上就再也建不了第二部了；
 * 而能力清单一直是绿的，因为 `// cap:project-new` 那行标记确实在。
 *
 * 所以这条断言的关键不是"能不能建"，是**在有项目的状态下能不能建** ——
 * 这正是它漏掉的那种情形。
 */
await page.locator('.top button:has-text("＋")').click();
await page.waitForTimeout(300);
const sheetUp = (await page.locator('.sheet-box').count()) > 0;
console.log('⑦b 有项目时也能新建：', sheetUp ? '弹出来了 ✓' : '✕ 顶栏上没有入口');
if (sheetUp) {
  await page.locator('.sheet-box input').fill('第二部片子');
  await page.locator('.sheet-box button:has-text("建")').first().click();
  await page.waitForTimeout(1200);
  const names = store.list().map((x) => x.title);
  console.log('   建出来了：', names.includes('第二部片子') ? '✓' : `✕ ${JSON.stringify(names)}`);
  console.log('   浮层关掉了：', (await page.locator('.sheet-box').count()) === 0 ? '✓' : '✕ 还挡着');
  // 建完要切过去 —— 建了却还停在旧项目上，人会以为没建成，然后再建一个
  console.log('   自动切到新项目：',
    /第二部片子/.test(await page.locator('.top').innerText()) ? '✓' : '✕ 还停在旧项目');
}

/**
 * ⑧b 白天模式。
 *
 * 用户的原话："手机版要有白天使用模式，现在 ui 全是黑的，晚上看不见"。
 * 深色在暗处很好，在日光下的手机屏上是另一回事 —— 屏幕反光加上深底浅字，
 * 对比度直接塌掉。
 *
 * 量的是**真的换了像素**（读 body 的实际背景色），不是"有个按钮能点"——
 * 只验按钮存在的话，一个把 class 加错了的实现照样绿。
 *
 * ⚠ 系统偏好要**自己钉死**。Playwright 的 iPhone 模拟默认是浅色系统，
 * 于是"跟随系统"一开始就已经是浅的 —— 第一版断言假设它从深色起步，
 * 结果量了个寂寞（点完之后颜色确实没变，因为本来就是那个颜色）。
 */
{
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lum = (c) => (c.match(/\d+/g) || [0, 0, 0]).slice(0, 3).reduce((a, b) => a + Number(b), 0) / 3;
  const themeBtn = page.locator('.top button').filter({ hasText: /[◐☀☾]/ }).first();
  console.log('⑧b 顶栏有配色开关：', (await themeBtn.count()) === 1 ? '✓' : '✕ 找不到');

  // 系统=深色，且没手动选过 → 跟着系统走
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  const autoDark = await bg();
  console.log('   跟随系统：系统深色时是深的：', lum(autoDark) < 60 ? `✓ ${Math.round(lum(autoDark))}` : `✕ ${autoDark}`);
  // 系统=浅色 → 同一个"跟随"要跟着变
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(200);
  const autoLight = await bg();
  console.log('   跟随系统：系统浅色时是浅的：', lum(autoLight) > 180 ? `✓ ${Math.round(lum(autoLight))}` : `✕ ${autoLight}`);

  // 手动选浅色 —— 这一下之后系统说什么都不算数了
  await themeBtn.click();
  await page.waitForTimeout(300);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  const forcedLight = await bg();
  console.log('   手动选白天后，系统转深色也不跟：',
    lum(forcedLight) > 180 ? `✓ ${Math.round(lum(forcedLight))}` : `✕ ${forcedLight}`);

  // 刷新之后要记得住 —— 每次打开都要重点一次的话，等于没有
  await page.reload();
  await page.waitForTimeout(1500);
  console.log('   刷新之后还记得：', lum(await bg()) > 180 ? '✓' : `✕ ${await bg()}`);

  // 再点一下 → 强制深色，此时系统是深色，要靠 data-theme 证明它是"强制"的
  await page.locator('.top button').filter({ hasText: /[◐☀☾]/ }).first().click();
  await page.waitForTimeout(300);
  const attr = await page.evaluate(() => document.documentElement.dataset.theme || '');
  console.log('   再点一下变强制夜间：', attr === 'dark' ? '✓' : `✕ data-theme=${attr}`);
  // 回到跟随系统
  await page.locator('.top button').filter({ hasText: /[◐☀☾]/ }).first().click();
  await page.waitForTimeout(300);
  console.log('   第三下回到跟随系统：',
    (await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))) === false ? '✓' : '✕');
  await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * ⑧c 出片规格：画幅和分辨率记在**这部片子**上。
 *
 * 用户的原话："有的时候是在手机新建项目，不默认他们的设置"。
 * 全局设置是坐在电脑前为上一部片子调的，而这两样一旦跑起来就改不动了：
 * 分镜图按那个比例出完、视频跟着图走，发现不对时钱已经花掉了。
 *
 * ⚠ 断言必须对着**页面当前打开的那部片子**读。
 * 第一版写死了 proj.id，而 ⑦b 刚刚新建并切到了另一部 —— PATCH 打在
 * 新的那部上，断言却去查旧的那部，于是"分辨率没存上"红了半天，
 * 功能其实一直是好的。而"画幅存上了"那条同时是**假绿**：
 * 旧项目本来就是 9:16，怎么点都对。
 */
{
  await page.locator('.tab', { hasText: '剧本' }).click();
  await page.waitForTimeout(700);
  const body = await page.locator('.body').innerText();
  console.log('⑧c 剧本页有「出片规格」：', /出片规格/.test(body) ? '✓' : `✕ ${body.slice(0, 120)}`);
  console.log('   画幅和分辨率都在：',
    /画幅/.test(body) && /视频分辨率/.test(body) ? '✓' : '✕');

  // 页面在哪一部上，就查哪一部
  const openId = await page.evaluate(() => localStorage.getItem('fd.m.project'));
  const before = store.read(openId);
  const ratioChip = page.locator('.chip', { hasText: '16:9 横屏' }).first();
  const resChip = page.locator('.chip', { hasText: '480P 省钱' }).first();
  if ((await ratioChip.count()) && (await resChip.count())) {
    await ratioChip.click();
    await resChip.click();
    await page.locator('button:has-text("保存规格")').first().click();
    await page.waitForTimeout(1200);
    const saved = store.read(openId);
    // 前后要真的不一样，否则这两条可能只是在量一个本来就对的初值
    console.log('   画幅存到项目上：',
      saved.aspectRatio === '16:9' && before.aspectRatio !== '16:9'
        ? '✓' : `✕ ${before.aspectRatio} → ${saved.aspectRatio}`);
    console.log('   分辨率也存到项目上：',
      saved.videoResolution === '480P' && before.videoResolution !== '480P'
        ? '✓' : `✕ ${before.videoResolution} → ${saved.videoResolution}`);
  } else {
    console.log('   ✕ 选项点不到');
  }
}

/**
 * ⑧d 接缝那句话要说**当前模式**的行为。
 *
 * 这张卡片上原来写着「标成连续动作会把上一镜的末帧锁成下一镜的首帧」——
 * 那描述的是 tail 模式，而默认跑的是 lock（首尾帧）。用户照着这句话去看成片，
 * 看到"这一段的第一帧根本不是上一段的最后一帧"，只能得出"坏了"的结论。
 * 他的原话就是："怎么是上一镜尾帧为下一镜的首帧？不是首尾帧？"
 */
{
  /**
   * ⚠ 先切回**有分镜的那部片子**。
   *
   * ⑦b 刚刚新建并切到了一部空的，那上面根本没有分镜页 ——
   * 直接查会得到"找不到「整段标衔接」"，而那是测试站错了地方，不是功能没做。
   * 这个坑在 ⑧c 上已经栽过一次了。
   */
  await page.evaluate((id) => localStorage.setItem('fd.m.project', id), proj.id);
  await page.reload();
  await page.waitForTimeout(1200);
  await page.locator('.tab', { hasText: '分镜' }).click();
  await page.waitForTimeout(800);
  // 它收在分镜页那排筛选后面的「⋯」里（偶尔用一次的东西不该占掉小半屏）
  /**
   * ⚠ 按**图标**认，不要用 .last()。
   *
   * 原来筛选条上只有一个图标按钮，.last() 正好是「⋯」。后来加了指令框的
   * 「⌘」，.last() 就变成了它 —— 于是这一节点开的是指令框，
   * 然后报「分镜页上找不到整段标衔接」，看起来像接缝功能没了。
   * 位置型选择器在界面长出新东西时会这样静默指错地方。
   */
  const more = page.locator('.fchip.icon', { hasText: '⋯' }).first();
  if (await more.count()) {
    await more.scrollIntoViewIfNeeded();
    await more.click({ force: true });
    await page.waitForTimeout(800);
  }

  // 它是弹出来的一层（.sheet），不在 #app 里面
  const card = page.locator('.sheet', { hasText: '整段标衔接' }).first();
  if (await card.count()) {
    const text = await card.innerText();
    const modeNamed = /「首尾帧」|「接住真实末帧」|「关掉」/.test(text);
    console.log('⑧d 接缝卡片点名了当前模式：', modeNamed ? '✓' : `✕ ${text.slice(0, 140)}`);
    // 默认是首尾帧 —— 那就必须说清楚"接缝做在上一镜身上"，不能说反
    const rightWay = !/「首尾帧」/.test(text) || /做在\*\*上一镜\*\*身上|做在上一镜身上/.test(text);
    console.log('   首尾帧模式下没把话说反：', rightWay ? '✓' : `✕ ${text.slice(0, 200)}`);
    console.log('   说清了只在标了连续动作的地方才做：',
      /连续动作/.test(text) ? '✓' : `✕ ${text.slice(0, 120)}`);
  } else {
    console.log('⑧d 接缝卡片：✕ 分镜页上找不到「整段标衔接」');
  }
  // ⚠ 弹层不关掉的话，后面每一步的点击都会被它挡住（Playwright 会一直重试到超时）
  await page.evaluate(() => document.querySelectorAll('.sheet').forEach((n) => n.remove()));
  await page.waitForTimeout(200);
}

/**
 * ⑧e 场地图 —— 手机上真的点得开、拖得动。
 *
 * 这一块在手机上不是"电脑那套缩小塞进来"：两指捏合缩放、一指平移
 * 本来就是触屏的母语。但正因为它是新写的一套手势，最容易出的问题是
 * **一根手指拖场景时，画布跟着一起平移** —— 那样场景永远拖不到该在的地方，
 * 而不会有任何报错。
 */
{
  // 老规矩：先切回有设定集的那部片子（⑦b 切走过一次，⑧c/⑧d 都在这儿栽过）
  await page.evaluate((id) => localStorage.setItem('fd.m.project', id), proj.id);
  await page.reload();
  await page.waitForTimeout(1200);
  // ⚠ 底部那一栏的标签是「设定」，不是「设定集」——「设定集」是流水线步骤名
  await page.locator('.tab', { hasText: '设定' }).click();
  await page.waitForTimeout(900);

  /**
   * ⚠ 按**标题文字**找，不能拿 .site-details 的第一个。
   *
   * 设定集页上现在有两张同类卡片（「剧本又加了新章？」和「场地图」），
   * .first() 会点开上面那张 —— 然后找不到 .site-panel，报成"场地图坏了"。
   * 而那是测试站错了地方。
   */
  const head = page.locator('.site-details', { hasText: '场地图' }).locator('summary').first();
  if (!(await head.count())) {
    console.log('⑧e 场地图：✕ 设定集页上找不到入口');
  } else {
    /**
     * ⚠ 触控目标别小于 36px。
     *
     * summary 默认只有一行文字高（约 20px），在手机上是点不准的 ——
     * 而这一点用眼睛看截图是看不出来的，只能量。
     */
    const box = await head.boundingBox();
    console.log('⑧e 场地图入口够大点：',
      box && box.height >= 32 ? '✓' : `✕ 只有 ${box ? Math.round(box.height) : 0}px 高`);
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await page.waitForTimeout(700);
    console.log('   卡片能展开：', (await page.locator('.site-panel').count()) ? '✓' : '✕');

    // 还没有场地时不能是一块空白 —— 空白让人以为功能坏了
    const why = await page.locator('.site-empty-why').first().innerText().catch(() => '');
    console.log('   空的时候说清了这是干什么的：',
      /场景/.test(why) ? '✓' : `✕ ${why.slice(0, 100)}`);

    const start = page.locator('.site-empty button').first();
    if (await start.count()) {
      await start.click();
      await page.waitForTimeout(900);
    }
    const hasCanvas = (await page.locator('svg.site-canvas').count()) > 0;
    console.log('   画布画出来了：', hasCanvas ? '✓' : '✕');

    if (hasCanvas) {
      /**
       * ⚠ 触摸拖动必须**不带动画布平移**。
       *
       * 圆点上的 pointerdown 要 stopPropagation，否则 SVG 那层也收到，
       * 于是拖一个场景变成"场景和整张图一起走"，相对位置纹丝不动 ——
       * 界面看起来在动，而存下去的坐标一点没变。所以这里量的是
       * **圆点相对网格有没有真的移动**，不是"有没有动"。
       */
      const dot = page.locator('.site-place').first();
      const before = await dot.getAttribute('cx');
      const box = await dot.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(box.x + box.width / 2 + i * 7, box.y + box.height / 2);
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForTimeout(700);
      const after = await page.locator('.site-place').first().getAttribute('cx');
      console.log('   拖场景真的挪了位置（不是整张图跟着走）：',
        before !== after ? '✓' : `✕ 拖前拖后都是 ${before}`);

      /**
       * ⚠ 从 Node 这一侧读盘，不要在页面里 fetch。
       *
       * 手机版的 /api 是要口令的，页面里裸 fetch 拿回来的是 401 的 JSON，
       * 读 `.bible` 就炸 —— 而那报的是测试自己的错，不是功能的错。
       * 别处（⑤c）也是直接 store.read，跟着来。
       */
      const saved = (store.read(proj.id).bible.scenes || []).filter((s) => s.place).length;
      console.log('   位置落到盘上了：', saved >= 1 ? '✓' : '✕ 界面动了但没存住');

      // 比例尺：缩放之后没有它，没人知道自己在看多大一块地
      console.log('   有比例尺：', (await page.locator('.site-scale-label').count()) ? '✓' : '✕');
    }
  }
}

/**
 * ⑧f 手机版的「改了要重出 X」。
 *
 * 三样东西喂的是不同的下游：画面→出图、运镜/衔接→出视频、台词→配音。
 * 改一样东西要付多少代价差着几十倍的钱，而原来两端都没说。
 * 电脑版补上了，手机版原来落下了 —— 三端对齐那条自检抓不到这种事：
 * 它管得了"功能在不在"，管不了"提示在不在"。
 */
{
  await page.evaluate((id) => localStorage.setItem('fd.m.project', id), proj.id);
  await page.reload();
  await page.waitForTimeout(1200);
  await page.locator('.tab', { hasText: '分镜' }).click();
  await page.waitForTimeout(800);
  // 同上：走点描述这条高频路径（「改这一镜」在「⋯」那张动作表里）
  await page.locator('.shot-desc.tappable').first().click();
  await page.waitForTimeout(500);
  const ed2 = page.locator('.ed');
  const state = {
    img: Boolean(store.read(proj.id).shots[0].imagePath),
    vid: Boolean(store.read(proj.id).shots[0].videoPath),
    aud: Boolean(store.read(proj.id).shots[0].audioPath)
  };
  const contentRedo = await ed2.locator('.ed-redo').allInnerTexts();
  console.log('⑧f 手机上「改了要重出 X」：',
    (state.img ? contentRedo.some((t) => /重出这一镜的图/.test(t)) : true)
    && (state.aud ? contentRedo.some((t) => /重新配音/.test(t)) : true)
      ? '✓' : `✕ ${JSON.stringify({ state, contentRedo })}`);
  console.log('   分组标出了喂给哪一步：',
    /出图用的/.test(await ed2.innerText()) ? '✓' : '✕');
  // 「镜头」那一页管出视频
  await ed2.locator('.ed-tab:has-text("镜头")').click();
  await page.waitForTimeout(300);
  console.log('   镜头这一组标着出视频用的：',
    /出视频用的/.test(await ed2.innerText()) ? '✓' : '✕');
  await ed2.locator('.ed-top button:has-text("取消")').click().catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll('.ed').forEach((n) => n.remove()));
}

// ⑧ 往后全跑
await page.locator('.tab', { hasText: '流水线' }).click();
await page.waitForTimeout(500);
console.log('⑧ 每步都能"往后全跑"：', (await page.locator('button:has-text("往后全跑")').count()) === 6 ? '✓' : '✕');

// 手机上看图靠查询串带配对码 —— 这条链路坏了的表现是"全是碎图"，而页面本身一切正常
const shotImg = store.read(proj.id).shots[0].imagePath;
const withK = await fetch(`${base}/media?p=${encodeURIComponent(shotImg)}&k=${token}`);
const withoutK = await fetch(`${base}/media?p=${encodeURIComponent(shotImg)}`);
console.log('   带码取图：', withK.status === 200 ? '✓' : `✕ ${withK.status}`,
  '｜不带码：', withoutK.status === 401 ? '✓ 挡住' : `✕ ${withoutK.status}`);
// 上面那条是 Node 直接发的，不经过页面，所以不会进 unexpected4xx —— 这里不用放行

// ⑨ PWA 三件套
const man = await fetch(`${base}/m/manifest.webmanifest`);
const sw = await fetch(`${base}/m/sw.js`);
const icon = await fetch(`${base}/m/icon-192.png`);
console.log('⑨ manifest / sw / icon：', [man.status, sw.status, icon.status].join(' '),
  man.status === 200 && sw.status === 200 && icon.status === 200 ? '✓' : '✕');

// ⑩ 触控目标够不够大（拇指按不中的按钮等于没有）
const small = await page.evaluate(() =>
  [...document.querySelectorAll('button, .tab, a.btn')]
    .map((el) => ({ t: el.innerText.trim().slice(0, 8), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h > 0 && x.h < 36));
console.log('⑩ 小于 36px 的可点元素：', small.length ? JSON.stringify(small) : '没有 ✓');

/**
 * ⑪ 钱：手机上也得看得见。
 *
 * ⚠ 这一节有一层只有**真手机浏览器**能验：手机版会 import `/pricing.js`。
 * 那是个直接发原件的模块，而局域网那条口子是**白名单放行**的 ——
 * 忘了把它加进 SHARED_MODULES，它就会 401，
 * 而 import 失败会让**整个 m.js 加载不起来**：手机上打开一片空白，
 * 连"请输入配对码"那一屏都没有。这种坏法在 Node 里的自检中完全看不见。
 *
 * 所以下面这几行同时在验两件事：卡片在不在，以及那个模块放行了没有。
 */
await page.locator('.tab', { hasText: '设定' }).click();
await page.waitForTimeout(800);
{
  const card = page.locator('details.card', { hasText: '花了多少' }).first();
  const there = (await card.count()) > 0;
  console.log('⑪ 手机上看得到账：', there ? '✓' : '✕ 卡片不在');
  if (there) {
    await card.locator('summary').click();
    await page.waitForTimeout(900);
    const body = await card.innerText().catch(() => '');
    console.log('   说得出这个项目发过什么：', /这个项目到现在/.test(body) ? '✓' : `✕ ${body.slice(0, 80)}`);
    // 没填单价时必须说"还没填"，不能显示 ¥0 —— 未知当 0 是这个功能要消灭的东西
    console.log('   没填单价时不显示 ¥0：',
      !/¥\s*0(\D|$)/.test(body) ? '✓' : `✕ ${body.slice(0, 100)}`);
    console.log('   摊开了每一档的用量：',
      /出图/.test(body) && /出视频/.test(body) ? '✓' : `✕ ${body.slice(0, 120)}`);
    console.log('   就地能填单价：',
      (await card.locator('.rate-row input').count()) > 0 ? '✓' : '✕ 没有输入框');
    // 填一个，钱要当场出现 —— "存的是用量、钱现算"这个设计的唯一可见证据
    await card.locator('.rate-row input').first().fill('0.2');
    await card.locator('button:has-text("存单价")').click();
    await page.waitForTimeout(1200);
    const after = await card.innerText().catch(() => '');
    console.log('   填完单价，钱当场算出来：', /¥\d/.test(after) ? '✓' : `✕ ${after.slice(0, 140)}`);
  }
}

/**
 * ⑫ 这一镜出图带了哪几张参考图。
 *
 * 用户传了自己的照片、出来的脸不是他的，而**手机上一个字都没有** ——
 * 他没法判断是"图没发出去"还是"发了但模型没保住脸"，而这两件事
 * 下一步完全不同。他的原话就是"我用的手机端"。
 *
 * ⚠ 一张都没带时**更要说**。走查机上的分镜就是没带参考图那种，
 * 所以这里正好验到那条最要紧的分支：沉默在这里等于误导。
 */
await page.locator('.tab', { hasText: '分镜' }).click();
await page.waitForTimeout(800);
{
  /**
   * ⚠ 用 textContent 不用 innerText。
   *
   * 参考图那一行在卡片改成三层之后收进了折叠的「详情」，
   * 而 innerText 对**没渲染出来**的内容返回空串 —— 于是这一条从那次
   * 改版起就一直是红的，看起来像"手机上不说带没带参考图了"，
   * 其实只是这条断言看不见折起来的部分。收起来 ≠ 删掉。
   */
  const txt = await page.locator('.shot').first().evaluate((el) => el.textContent || '').catch(() => '');
  const said = /出图带了参考图|张图可以带|还没有图|早前出的/.test(txt);
  console.log('⑫ 手机上说得出这一镜带没带参考图：', said ? '✓' : `✕ ${txt.slice(0, 120)}`);
  /**
   * ⚠ 没带的时候要说清**是哪一种没带** —— 那句话盖住的两种情况
   * 下一步动作背道而驰：没有图（去出一张）vs 有图没发（去改设置）。
   * 走查机上的分镜是"设定集有图、但这次没发"那种，所以该出现的是后一句。
   */
  console.log('   而且说得出是哪一种没带（有图没发 ≠ 压根没图）：',
    !/张图可以带/.test(txt) || /出分镜图时带哪些参考图/.test(txt) ? '✓' : `✕ ${txt.slice(0, 200)}`);
}

/**
 * ⑬ 手机上传一张自己的图当设定图。
 *
 * 用户的原话："要么你在手机上添加一个上传图片的功能"。手机上原来完全没有 ——
 * 而这件事恰恰最该在手机上做：想用的那张脸多半就在手机相册里。
 *
 * ⚠ 这一条以前**没登记进能力清单**，所以"三端对齐"那条自检从来没红过。
 * 那份清单只在有人登记时才起作用，漏登记的功能它一个字都不会说。
 */
await page.locator('.tab', { hasText: '设定' }).click();
await page.waitForTimeout(800);
{
  const card = page.locator('.card', { hasText: '阿澜' }).first();
  const btn = card.locator('button', { hasText: '传一张图' });
  console.log('⑬ 手机上有"传一张图"：', (await btn.count()) > 0 ? '✓' : '✕ 没有这个按钮');
  console.log('   有文件选择器（点了要能打开相册）：',
    (await card.locator('input[type=file]').count()) > 0 ? '✓' : '✕');
  /**
   * ⚠ 还要说清**这张图哪来的**。用户撞上的死结就是这个：
   * 分镜说"没带你传的图"，而他确信设定集里就是他的照片 ——
   * 两句话必有一句错，而在设定集上标出来源当场就分得清。
   */
  const t = await card.innerText();
  console.log('   说得出这张图是谁出的：',
    /这张是你传的|这张是模型出的/.test(t) ? '✓' : `✕ ${t.slice(0, 120)}`);
}

// 第 ② 步是**故意**敲错配对码，那一次 401 是预期之内的，不算页面报错
const realErrs = errs.filter((e) => !/401/.test(e));
/**
 * ══════════ 镜头卡的分层 ══════════
 *
 * 用户："整个提示也好，卡片下面的功能也好都太杂太乱了"。
 * 每报一个问题我就往卡上加一行字或一颗按钮，加了十几次、一次没删过。
 *
 * ⚠ 这几条守的是**克制**，而克制是最容易被下一次改动悄悄吃掉的东西：
 * 下次再有人往卡上加一颗按钮，这里会红。
 */
{
  await page.locator('.tab', { hasText: '分镜' }).click();
  await page.waitForTimeout(800);
  const card = page.locator('.card.shot').first();
  const btns = card.locator('.shot-info > .acts > button');
  const n = await btns.count();
  console.log('\n⑭ 镜头卡分层：');
  console.log('   卡面上最多两个按钮（一个主动作 + 一个「⋯」）：', n <= 2 ? '✓' : `✕ 有 ${n} 个`);
  /** 高频动作（改文案）不该多一次点击 */
  console.log('   点描述就能改（改文案是最高频的动作）：',
    (await card.locator('.shot-desc.tappable').count()) === 1 ? '✓' : '✕');
  /** 排查用的东西默认收起来，但一样都没少 */
  const more = card.locator('details.shot-more');
  console.log('   排查用的收进折叠区：', (await more.count()) === 1 ? '✓' : '✕');
  console.log('   默认是折起来的：', (await more.evaluate((el) => el.open)) === false ? '✓' : '✕');
  await more.locator('summary').click();
  await page.waitForTimeout(300);
  console.log('   点开之后参考图那行还在（藏起来 ≠ 删掉）：',
    /参考图|还没有图|早前出的/.test(await more.innerText()) ? '✓' : `✕ ${(await more.innerText()).slice(0, 40)}`);
}

/**
 * ⑮ 指令框（手机端）
 *
 * ⚠ 手机端更需要它 —— 51 张卡翻起来最费手的就是手机，批量操作在小屏上
 * 几乎没法做。所以这一节验的不是"元素在不在"，是那条
 * 输入 → 请求 → 预览 → 按钮变样 的链**在手机上也整条通**。
 */
{
  console.log('\n⑮ 指令框：');
  const chip = page.locator('.fchip.icon', { hasText: '⌘' }).first();
  console.log('   筛选条上有入口：', (await chip.count()) === 1 ? '✓' : '✕');
  await chip.click();
  await page.waitForTimeout(600);
  const ta = page.locator('.sheet textarea.mta').first();
  console.log('   点开是个输入框：', (await ta.count()) === 1 ? '✓' : '✕');

  // 例子按项目生成，先看它填没填上
  const egs = page.locator('.cmd-eg .fchip');
  const egN = await egs.count();
  console.log('   给了可点的例子：', egN > 0 ? `✓ ${egN} 条` : '✕');

  await ta.fill('第 1 镜改成特写');
  await page.waitForTimeout(1200);
  const prev = page.locator('.sheet .cmd-preview').first();
  const said = (await prev.textContent()) || '';
  console.log('   预览说清了要做什么：', /特写/.test(said) ? `✓ ${said.slice(0, 26)}` : `✕ ${said.slice(0, 40)}`);
  const btn = page.locator('.sheet .cmd-preview ~ .row button').first();
  console.log('   执行按钮可按：', !(await btn.isDisabled()) ? '✓' : '✕');

  await ta.fill('哦豁');
  await page.waitForTimeout(1200);
  console.log('   看不懂时说看不懂：',
    ((await prev.getAttribute('class')) || '').includes('bad') ? '✓' : '✕');
  console.log('   而且按钮不可按（绝不执行没听懂的指令）：',
    (await page.locator('.sheet .cmd-preview ~ .row button').first().isDisabled()) ? '✓' : '✕');

  // 真按一次，验它确实改到了分镜
  await ta.fill('第 1 镜改成特写');
  await page.waitForTimeout(1200);
  await page.locator('.sheet .cmd-preview ~ .row button').first().click();
  await page.waitForTimeout(1500);
  const gone = (await page.locator('.sheet').count()) === 0;
  console.log('   改完把抽屉关掉：', gone ? '✓' : '✕');
  /**
   * ⚠ 改完要**真的改到了**，不是只把抽屉关掉。
   * 只验"抽屉关了"的话，一个什么都不做、按完就关的按钮照样能过。
   * 这里回列表看第 1 镜的景别标签。
   */
  console.log('   页面回到分镜列表：',
    (await page.locator('.shot-desc.tappable').count()) > 0 ? '✓' : '✕');
  /**
   * ⚠ 用 textContent 不用 innerText。景别标签收在折叠的「详情」里，
   * 而 innerText 对**没渲染出来**的内容返回空串 —— 这个坑这一轮已经踩过一次了。
   */
  const listText = await page.locator('#app').evaluate((el) => el.textContent || '');
  console.log('   第 1 镜真的变成特写了：', /特写/.test(listText) ? '✓' : '✕ 列表里找不到「特写」');
}

/**
 * ⑯ 撤销（手机端）
 *
 * 手滑最容易发生在手机上，所以这条路在手机上比在电脑上更要紧。
 * 验的是整条链：改 → 撤销按钮带名字地出现 → 点了真的退回去。
 */
{
  console.log('\n⑯ 撤销：');
  const chip = page.locator('.fchip.icon', { hasText: '⌘' }).first();
  await chip.click();
  await page.waitForTimeout(700);
  const ta = page.locator('.sheet textarea.mta').first();
  await ta.fill('第 1 镜改成大特写');
  await page.waitForTimeout(1200);
  await page.locator('.sheet .cmd-preview ~ .row button').first().click();
  await page.waitForTimeout(1600);

  await chip.click();
  await page.waitForTimeout(900);
  const undoBtn = page.locator('.sheet .undo-bar button').first();
  console.log('   改完之后有撤销按钮：', (await undoBtn.count()) === 1 ? '✓' : '✕');
  const label = (await undoBtn.textContent().catch(() => '')) || '';
  console.log('   按钮上写着退的是哪一步：', /景别|镜/.test(label) ? `✓ ${label.slice(0, 26)}` : `✕ ${label}`);
  page.once('dialog', (d) => d.accept());
  await undoBtn.click();
  await page.waitForTimeout(1800);
  /**
   * ⚠ 读**折叠区里那个标签的文本**要用 textContent，而且要读得准 ——
   * 整页 textContent 里"大特写"会在别处出现（帮助文字、档位清单），
   * 那样验的是运气。这里只读第一张卡。
   */
  const card1 = await page.locator('.shot').first().evaluate((el) => el.textContent || '').catch(() => '');
  console.log('   第 1 镜退回去了：', !/大特写/.test(card1) ? '✓' : `✕ ${card1.slice(0, 60)}`);
}

/**
 * ⑰ 提示词分层（手机端）
 *
 * 放在「看看为什么」抽屉里：先看有没有明确原因 → 没有的话看看是不是
 * 哪一层在抢戏 → 再决定花不花这笔钱。顺序就是判断顺序。
 */
{
  console.log('\n⑰ 提示词分层：');
  await page.locator('.tab', { hasText: '分镜' }).click();
  await page.waitForTimeout(700);
  const why = page.locator('.shot .btn.primary', { hasText: '为什么' }).first();
  if (await why.count()) {
    await why.evaluate((el) => el.click());
    await page.waitForTimeout(1800);
    const fold = page.locator('.sheet details.layer-fold').first();
    console.log('   「看看为什么」里有分层这一块：', (await fold.count()) === 1 ? '✓' : '✕');
    await fold.evaluate((el) => { el.open = true; }).catch(() => {});
    await page.waitForTimeout(900);
    const rows = await page.locator('.sheet .layer-row').count();
    console.log('   摊开了几层：', rows >= 3 ? `✓ ${rows} 层` : `✕ ${rows}`);
    const names = (await page.locator('.sheet .layer-name').allTextContents()).join('|');
    console.log('   每层有中文名：', /演什么|画风|人物|场景|景别/.test(names) ? `✓ ${names.slice(0, 30)}` : `✕ ${names}`);
    /**
     * ⚠ 比的是 **DOM 顺序**，不是文本里谁先出现。
     * 第一版拿 indexOf('重出') 找按钮，结果匹配到的是**诊断正文**里的
     * "→ 重出这张图。"。用文本位置代替元素位置，验的是运气。
     */
    const order = await page.locator('.sheet').first().evaluate((el) => {
      const f = el.querySelector('details.layer-fold');
      const btn = [...el.querySelectorAll('button')].find((b) => /重出|再出一张/.test(b.textContent || ''));
      if (!f) return 'no-fold';
      if (!btn) return 'no-btn';
      return (f.compareDocumentPosition(btn) & 4) ? 'ok' : 'wrong';
    });
    console.log('   分层排在重出按钮之前（先搞明白，再决定花钱）：',
      order === 'ok' || order === 'no-btn' ? '✓' : `✕ ${order}`);
  } else {
    console.log('   ✕ 分镜页上找不到「看看为什么」按钮');
  }
}

/**
 * ⑱ 焦段（手机端）
 *
 * 审片时发现"这几镜背景太散"，换个长焦是当场就想做的事 ——
 * 而审片正是在手机上做的。
 */
{
  console.log('\n⑱ 焦段：');
  /**
   * ⚠ 先把上一节可能还开着的抽屉关掉。
   * 留一张开着的抽屉会挡住页签，然后报成"页签点不到"——
   * 查半天在查一件跟本节毫无关系的事。
   */
  await closeSheets(page);
  await page.waitForTimeout(300);
  await page.locator('.tab', { hasText: '分镜' }).click();
  await page.waitForTimeout(700);
  await page.locator('.shot-desc.tappable').first().click();
  await page.waitForTimeout(1400);
  /**
   * ⚠ 编辑器是分页的（内容 / 镜头 / 预演台 / 高级），默认停在「内容」。
   * 景别和焦段在「镜头」那一页 —— 不切过去的话，选择器永远匹配不到，
   * 而且不报错，看起来像"这个功能没做"。
   */
  await page.locator('.ed-tab', { hasText: '镜头' }).first().click();
  await page.waitForTimeout(500);
  // ⚠ 编辑器**不是** .sheet：openEditor 自己往 body 上挂了一层。
  //    带 .sheet 前缀的选择器在这儿永远匹配不到，而且不报错。
  const row = page.locator('.ed-group', { hasText: '焦段' }).first();
  console.log('   编辑器里有焦段这一项：', (await row.count()) >= 1 ? '✓' : '✕');
  const chips85 = page.locator('.chip', { hasText: '背景压缩' }).first();
  /** 括注写的是画面上看得出来的那件事，不是参数 —— 选的人未必懂毫米数 */
  console.log('   选项写的是人话不是参数：', (await chips85.count()) === 1 ? '✓ 85 背景压缩' : '✕');
  if (await chips85.count()) {
    await chips85.evaluate((el) => el.click());
    await page.waitForTimeout(300);
    const save = page.locator('button', { hasText: '保存' }).first();
    if (await save.count()) {
      await save.evaluate((el) => el.click());
      await page.waitForTimeout(1600);
      /**
       * ⚠ 用**界面自己**验存没存住：重新打开编辑器，看那颗芯片还亮着没有。
       *
       * 第一版是在页面里 fetch 一个自己拼的地址，而 id 拼空了 → 401，
       * 于是"意料之外的 4xx"那条护栏红了 —— 走查自己制造了一个假故障。
       * 同样的错这一轮已经犯过一次（指令框那节）。
       */
      await closeSheets(page);
      await page.locator('.shot-desc.tappable').first().click();
      await page.waitForTimeout(1300);
      await page.locator('.ed-tab', { hasText: '镜头' }).first().click();
      await page.waitForTimeout(500);
      const on = await page.locator('.chip.on', { hasText: '背景压缩' }).count();
      console.log('   选完存得住（重开编辑器还亮着）：', on === 1 ? '✓ 85mm' : '✕');
    }
  }
  await closeSheets(page);
  await page.evaluate(() => { for (const el of document.querySelectorAll('.ed')) el.remove(); });
  await page.waitForTimeout(300);
}

rejections.push(...(await page.evaluate(() => window.__fdRejections || []).catch(() => [])));
console.log('未处理的 Promise 拒绝：', rejections.length ? `✕ ${rejections.slice(0, 3).join(' | ')}` : '无 ✓');

console.log('意料之外的 4xx：', unexpected4xx.length ? `✕ ${unexpected4xx.slice(0, 4).join('、')}` : '无 ✓');
console.log('\n页面报错：', realErrs.length ? realErrs.slice(0, 4) : '无');
await b.close();
srv.stopLan();
process.exit(0);
