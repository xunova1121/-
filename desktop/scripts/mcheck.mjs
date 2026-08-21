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

const settings = await import('/home/user/-/desktop/core/settings.js');
const store = await import('/home/user/-/desktop/core/store.js');
const srv = await import('/home/user/-/desktop/core/server.js');

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
    scenes: [], props: [] };
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
await page.locator('button:has-text("改这一镜")').first().click();
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
  console.log('   主按钮就是该按的那个：',
    /重出这段视频/.test(await page.locator('.shot .btn.primary').first().innerText().catch(() => '')) ? '✓' : '✕');
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

// 第 ② 步是**故意**敲错配对码，那一次 401 是预期之内的，不算页面报错
const realErrs = errs.filter((e) => !/401/.test(e));
console.log('意料之外的 4xx：', unexpected4xx.length ? `✕ ${unexpected4xx.slice(0, 4).join('、')}` : '无 ✓');
console.log('\n页面报错：', realErrs.length ? realErrs.slice(0, 4) : '无');
await b.close();
srv.stopLan();
process.exit(0);
