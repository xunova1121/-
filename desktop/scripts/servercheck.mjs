/**
 * 服务器模式走查：**照线上的样子**起一个进程，用手机 UA 走一遍"从打开到进去"。
 *
 *     node scripts/servercheck.mjs
 *
 * 为什么单独一个：selftest 里那些服务器模式的检查全是拿裸 socket 发的，
 * 验的是"它拒绝什么"。而用户真正会卡住的是另一半 —— **它接受什么**：
 * 手机打开根地址会不会被送到手机版、那一屏问的是不是它该问的东西、
 * 口令填进去能不能进。这一段只有真浏览器跑得出来。
 *
 * 和 uicheck / mcheck 一样需要本机装了 Playwright，CI 不跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
let chromium; let devices;
try {
  const mod = await import(PW);
  chromium = mod.chromium || mod.default?.chromium;
  devices = mod.devices || mod.default?.devices;
  if (!chromium) throw new Error('这份 Playwright 里没有 chromium');
} catch {
  console.error('没找到 Playwright：npm i -g playwright && npx playwright install chromium');
  process.exit(2);
}

// ⚠ 不能用 new URL(...).pathname —— Windows 上它会给出 /C:/... 这种带盘符斜杠的路径
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-server-'));
const TOKEN = 'ZzAaBbCcDdEeFf112233445566778899';
const HOST = 'fd.example.com';

let bad = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✕\x1b[0m'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) bad += 1;
};

/**
 * 起一个**真的服务器模式进程**。
 *
 * 不能在本进程里 import 后改 env —— 模式是 deploy.js 求值时从 env 读的，
 * 那样起出来的还是桌面模式，测了个寂寞（这个坑之前踩过一次）。
 */
const child = spawn(process.execPath, [path.join(ROOT, '..', 'core', 'server.js')], {
  env: {
    ...process.env,
    FUTUREDREAM_DATA_DIR: SANDBOX,
    FUTUREDREAM_MODE: 'server',
    FUTUREDREAM_PUBLIC_HOST: HOST,
    FUTUREDREAM_ACCESS_TOKEN: TOKEN,
    FUTUREDREAM_NO_OPEN: '1',
    PORT: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`起不来：${log}`)), 15000);
  const tick = setInterval(() => {
    const m = log.match(/https?:\/\/[^\s]*?:(\d+)/) || log.match(/顺延到 (\d+)/);
    if (m) {
      clearInterval(tick);
      clearTimeout(timer);
      resolve(Number(m[1]));
    }
    // 服务器模式打印的是 https://<域名>，不带端口 —— 那就自己去问
    if (/未来创梦 已启动/.test(log) && !m) {
      clearInterval(tick);
      clearTimeout(timer);
      resolve(0);
    }
  }, 120);
  child.on('exit', (code) => {
    clearInterval(tick);
    clearTimeout(timer);
    reject(new Error(`退出了（code=${code}）：${log}`));
  });
});

// 端口没打印出来（服务器模式显示的是域名）就从系统里问一句
const realPort = port || Number(process.env.FD_TEST_PORT) || 5178;
const base = `http://127.0.0.1:${realPort}`;
console.log(`服务器模式走查：${base}（Host 伪装成 ${HOST}）`);

const b = await chromium.launch();
/**
 * Host 必须是配的那个域名，否则服务端一律 403（这条规矩本身是对的）。
 * 浏览器改不了 Host 头，所以在路由层把请求重写到本机端口 —— 相当于
 * 线上 Caddy 那一跳。
 */
const ctx = await b.newContext({
  ...devices['iPhone 13'],
  baseURL: `http://${HOST}`
});
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.host !== HOST) return route.continue();
  return route.continue({ url: `${base}${u.pathname}${u.search}` });
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

console.log('\n手机打开根地址');
const resp = await page.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
check('被送到手机版了', page.url().includes('/m'), page.url());
check('页面回的是 200', resp && resp.status() < 400, String(resp?.status()));

const body = await page.locator('body').innerText();
console.log('\n登录屏');
// 服务器上要填的是 32 位口令，不是局域网那个 8 位配对码
check('问的是访问口令，不是配对码', /访问口令/.test(body) && !/8 位配对码/.test(body), body.slice(0, 140));
const maxlen = await page.locator('input.code').getAttribute('maxlength');
check('输入框装得下 32 位', Number(maxlen) >= 32, String(maxlen));
const cap = await page.locator('input.code').getAttribute('autocapitalize');
check('不自动转大写（口令大小写混排，转了就废）', cap === 'none', String(cap));

console.log('\n填口令进去');
await page.locator('input.code').fill(TOKEN);
await page.locator('button:has-text("连接")').click();
await page.waitForTimeout(1500);
const after = await page.locator('body').innerText();
check('进去了', !/访问口令/.test(after), after.slice(0, 160));
check('看得到流水线', /设定集|还没有项目|新建/.test(after), after.slice(0, 160));

// 大小写被改坏的话，这里会当场原地不动 —— 这正是之前手机端登不进去的原因
console.log('\n口令大小写');
const upper = await page.evaluate(async (t) => {
  const r = await fetch('/api/health', { headers: { 'X-FD-Key': t.toUpperCase() } });
  return r.status;
}, TOKEN);
check('全大写的口令会被拒（说明没被抹平）', upper === 401, String(upper));

/**
 * 探测失败时仍然要能进。
 *
 * 界面能不能用，不该取决于一次探测成没成 —— 旧版本服务端没有这条路由、
 * 网络抖一下、被什么东西挡了，都会让它拿不到。上一版在这种情况下会退回
 * "局域网"那套：输入框缩成 12 位、强制大写，32 位口令**根本填不进去**，
 * 人被锁在门外而且完全看不出为什么。
 */
console.log('\n探不到模式的时候');
const ctx2 = await b.newContext({ ...devices['iPhone 13'], baseURL: `http://${HOST}` });
await ctx2.route('**/*', (route) => {
  const u = new URL(route.request().url());
  // 不是 abort 而是**永远不回应** —— 真实世界里挂住比失败常见，也更难查
  if (u.pathname === '/api/mode') return undefined;
  if (u.host !== HOST) return route.continue();
  return route.continue({ url: `${base}${u.pathname}${u.search}` });
});
const page2 = await ctx2.newPage();
/**
 * ⚠ 必须从**根地址**进，和真手机一样。
 *
 * 直接 goto `/m` 的话，页面 URL 仍是 fd.example.com，子资源（m.css / m.js）
 * 就得靠路由改写跨源转发 —— 而 Playwright 不允许子资源跨源改写，会直接
 * ERR_BLOCKED_BY_CLIENT，m.js 根本没加载。那时页面停在"正在连接…"，
 * 看起来和产品 bug 一模一样，其实是脚手架自己把脚本挡了。
 * 从根地址进，302 之后页面就落在 127.0.0.1 上，子资源同源，不用改写。
 */
await page2.goto(`http://${HOST}/`, { waitUntil: 'domcontentloaded' });
// 探测挂着不返回时也要能进 —— 这比"探测失败"更阴：既不成功也不失败
await page2.waitForTimeout(3000);
check('探测挂住也不会卡在"正在连接"', !/正在连接/.test(await page2.locator('body').innerText()));
const len2 = (await page2.locator('input.code').count())
  ? await page2.locator('input.code').getAttribute('maxlength')
  : '0';
check('输入框照样装得下 32 位', Number(len2) >= 32, String(len2));
await page2.locator('input.code').fill(TOKEN);
check('填进去没被截断', (await page2.locator('input.code').inputValue()) === TOKEN);
await page2.locator('button:has-text("连接")').click();
// 登录成功后 boot() 会再走一遍那个探测（这一次同样挂着），所以要等过 2 秒超时
await page2.waitForTimeout(4000);
check('照样进得去', !/访问口令|配对码/.test(await page2.locator('body').innerText()));

/**
 * 账号：从"只有一串口令"到"用户名密码 + 每台设备一个会话"。
 *
 * 在真浏览器里走一遍，因为这一段最容易坏在**界面**上：接口全对，
 * 而登录屏问的还是口令、或者建完账号没自动登进去，用户照样卡在门口。
 */
console.log('\n账号');
/**
 * ⚠ 这两个上下文**直接打本机端口**，不做 Host 伪装。
 *
 * 伪装那套只在"从根地址进、被 302 带到本机"时才成立：一旦没有那次跳转，
 * 页面 URL 还停在假域名上，子资源就得靠路由跨源改写 —— 而 Playwright
 * 不允许，app.js 会被 ERR_BLOCKED_BY_CLIENT 挡掉，页面一片空白，
 * 看起来和"登录屏没画出来"一模一样。
 *
 * 而服务端本来就放行 loopback（线上 Caddy 那一跳走的正是它），
 * 所以直接打 127.0.0.1 既省事又更接近真实链路。
 */
const ctx3 = await b.newContext();
const page3 = await ctx3.newPage();
// 电脑版这一页的报错也要盯着 —— 上一版就是因为没盯，
// 一个"函数被误删"的低级错误让整页全白，而所有接口检查都是绿的
page3.on('pageerror', (e) => errs.push(`PC: ${e.message}`));
// 电脑版那一屏才有"顺手建账号"，手机上只登录 —— 所以走 ?pc=1
await page3.goto(`${base}/?pc=1`, { waitUntil: 'domcontentloaded' });
await page3.waitForTimeout(2500);
const loginText = await page3.locator('#view-inner').innerText().catch(() => '');
check('还没建账号时，问的是口令', /访问口令/.test(loginText), loginText.slice(0, 120));
check('并且顺手让你把账号建了', /顺手建个账号/.test(loginText), loginText.slice(0, 200));

await page3.locator('input[type=password]').first().fill(TOKEN);
await page3.locator('input[type=text]').first().fill('owner');
await page3.locator('input[autocomplete=new-password]').fill('a-strong-password');
await page3.locator('button:has-text("进入")').click();
await page3.waitForTimeout(2500);
const afterSetup = await page3.locator('body').innerText();
check('建完直接就进去了（不用再登一次）', !/访问口令|登录/.test(afterSetup.slice(0, 200)), afterSetup.slice(0, 160));

// 换一台设备：这次该问用户名密码了
const ctx4 = await b.newContext({ ...devices['iPhone 13'] });
const page4 = await ctx4.newPage();
await page4.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page4.waitForTimeout(1500);
const mLogin = await page4.locator('body').innerText();
// ⚠ placeholder 不进 innerText —— 第一版断言盯着"用户名"三个字，
// 而那三个字只在 placeholder 里，于是一个完全正确的界面被判成错的
check('手机上问的也是用户名密码了',
  (await page4.locator('input[autocomplete=username]').count()) === 1
    && !/配对码|访问口令/.test(mLogin), mLogin.slice(0, 100));

await page4.locator('input[autocomplete=username]').fill('owner');
await page4.locator('input[type=password]').fill('a-strong-password');
await page4.locator('button:has-text("登录")').click();
await page4.waitForTimeout(2500);
check('手机用账号登进去了', !/用户名或密码|登录/.test((await page4.locator('body').innerText()).slice(0, 120)));

// 两台设备各自一个会话 —— 这是这套东西存在的理由
const sessions = await page3.evaluate(async () => {
  const key = localStorage.getItem('fd.accessToken');
  const r = await fetch('/api/account/sessions', { headers: { 'X-FD-Key': key } });
  return r.json();
});
check('列得出两台设备', (sessions.sessions || []).length === 2, JSON.stringify((sessions.sessions || []).map((x) => x.device)));

check('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
child.kill();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(bad ? `\n\x1b[31m${bad} 项没过\x1b[0m` : '\n\x1b[32m服务器模式走查全过\x1b[0m');
process.exit(bad ? 1 : 0);
