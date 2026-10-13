/**
 * 桌面版测试：用 Playwright 启动真正的 Electron 应用（Linux 下用 xvfb-run 提供显示）。
 *   cd desktop && npm install && npm run prepare-app && cd .. && xvfb-run -a node e2e/desktop.mjs [截图目录]
 *   测试打包后的程序：JARVIS_DESKTOP_EXE=desktop/release/linux-unpacked/jarvis-desktop xvfb-run -a node e2e/desktop.mjs
 * 用临时 HOME，电脑操作只发生在临时目录里。
 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '../desktop');
const OUT = process.argv[2] || '.';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
fs.mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'Desktop', '项目计划.md'), '# 计划\n- 第一步');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};

// JARVIS_DESKTOP_EXE=打包好的程序路径：测试安装包里的应用；否则用源码目录运行
const EXE = process.env.JARVIS_DESKTOP_EXE;
const app = await electron.launch({
  executablePath: EXE || path.join(desktopDir, 'node_modules/electron/dist/electron'),
  args: [...(EXE ? [] : [desktopDir]), '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  env: { ...process.env, HOME, JARVIS_HOME: path.join(HOME, '.jarvis'), JARVIS_DESKTOP_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForSelector('.wb-tabs button', { timeout: 60000 });
await page.click('.wb-tabs button:nth-child(2)'); // 粒子舞台在“工作室”里
await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 3, null, { timeout: 60000 });
await page.click('.wb-tabs button:nth-child(1)');
await page.waitForFunction(() => window.__jarvis.gateway?.mcp, null, { timeout: 10000 }).catch(() => {});

async function ask(q, { approve } = {}) {
  // 工作台：功能页整页打开时对话区隐藏，先回到对话
  await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
  const before = await page.locator('#transcript .msg.agent').count();
  await page.fill('#prompt', q);
  await page.press('#prompt', 'Enter');
  if (approve) {
    await page.waitForSelector('.confirm-card:not(.answered) button', { timeout: 20000 });
    await page.locator('.confirm-card:not(.answered)').getByRole('button', { name: approve, exact: true }).click();
  }
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout: 30000 });
  await page.waitForTimeout(200);
  return page.locator('#transcript .msg.agent').last().innerText();
}

const info = await page.evaluate(() => ({ desktop: Boolean(window.jarvisDesktop), cls: document.body.className, origin: location.origin, badge: document.querySelector('#gw-badge').textContent, mcp: window.__jarvis.gateway?.mcp }));
check('桌面版启动：页面拿到 jarvisDesktop 接口', info.desktop && /desktop/.test(info.cls), JSON.stringify(info));
check('进程内网关（固定端口，MCP 可用）', /^http:\/\/127\.0\.0\.1:1878\d$/.test(info.origin) && info.mcp && info.badge === '桌面版', `${info.origin} · ${info.badge}`);
check('页面拿不到 Node / Electron', await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
check('未知操作被主进程拒绝', /未知操作/.test(await page.evaluate(() => window.jarvisDesktop.invoke('evil').catch((e) => e.message))));

// —— 操作电脑
let r = await ask('列出桌面');
check('查看桌面文件夹（无需确认）', /项目计划\.md/.test(r), r.slice(0, 120));

r = await ask('帮我写一个文件 桌面/贾维斯测试.txt', { approve: '允许' });
const written = path.join(HOME, 'Desktop', '贾维斯测试.txt');
check('写文件前在对话里征求同意，允许后写入磁盘', fs.existsSync(written) && /由贾维斯写入/.test(fs.readFileSync(written, 'utf8')), r.slice(-80));

r = await ask('帮我写一个文件 桌面/不该写入.txt', { approve: '拒绝' });
check('拒绝后不执行', !fs.existsSync(path.join(HOME, 'Desktop', '不该写入.txt')) && /拒绝/.test(r), r.slice(-80));

r = await ask('运行命令 echo jarvis-$((40+2))', { approve: '本次都允许' });
check('运行命令（确认后执行，返回输出）', /jarvis-42/.test(r), r.slice(-80));
r = await ask('运行命令 echo again');
check('选了“本次都允许”后同类操作不再询问', /again/.test(r) && (await page.locator('#transcript .msg.agent').last().locator('.confirm-card').count()) === 0);

const prot = await page.evaluate(() => window.jarvisDesktop.invoke('writeFile', { path: '/etc/jarvis-test', text: 'x' }).catch((e) => e.message));
check('系统目录受保护', /系统目录/.test(prot), prot);

r = await ask('截屏', { approve: '允许' });
check('截屏：先确认（截图会发给模型），再保存到工作区并交给模型查看', /已截屏（\d+×\d+），保存到工作区 截图\/屏幕-.*\.png/.test(r) && /截图已经交给我了/.test(r), r.slice(-80));
await page.screenshot({ path: `${OUT}/desktop-main.png` });

// —— 鼠标键盘控制（Linux 用 xdotool；坐标按截图比例换算成屏幕坐标）
{
  const { execFileSync } = await import('node:child_process');
  const mouse = () => { const m = execFileSync('xdotool', ['getmouselocation']).toString().match(/x:(\d+) y:(\d+)/); return { x: Number(m[1]), y: Number(m[2]) }; };
  const shot = await page.evaluate(async () => { await window.jarvisDesktop.invoke('controlBegin'); const r = await window.jarvisDesktop.invoke('controlLook'); return { w: r.width, h: r.height, len: r.base64.length }; });
  check('看屏幕：截取整屏（宽不超过 1440）', shot.w > 0 && shot.w <= 1440 && shot.len > 1000, JSON.stringify(shot));
  const scr = execFileSync('xdotool', ['getdisplaygeometry']).toString().trim().split(' ').map(Number);
  await page.evaluate((s) => window.jarvisDesktop.invoke('controlAct', { type: 'move', x: s.w / 4, y: s.h / 2, imgW: s.w, imgH: s.h }), shot);
  const m1 = mouse();
  check('截图坐标换算成屏幕坐标并移动鼠标', Math.abs(m1.x - scr[0] / 4) <= 2 && Math.abs(m1.y - scr[1] / 2) <= 2, `${JSON.stringify(m1)} 屏幕 ${scr.join('×')}`);
  const out = await page.evaluate((s) => window.jarvisDesktop.invoke('controlAct', { type: 'click', x: s.w + 50, y: 10, imgW: s.w, imgH: s.h }).catch((e) => e.message), shot);
  check('超出截图范围的坐标被拒绝', /超出截图范围/.test(out), out);
  execFileSync('xdotool', ['mousemove', '0', '0']);
  const stop = await page.evaluate((s) => window.jarvisDesktop.invoke('controlAct', { type: 'move', x: 100, y: 100, imgW: s.w, imgH: s.h }).catch((e) => e.message), shot);
  check('鼠标甩到左上角 = 紧急停止', /紧急停止/.test(stop), stop);
  await page.evaluate(() => window.jarvisDesktop.invoke('controlEnd'));

  // 智能体：看屏幕 → 点击（两次确认：看屏幕、操作鼠标）
  const before = await page.locator('#transcript .msg.agent').count();
  await page.fill('#prompt', `点击屏幕 ${Math.round(shot.w / 2)},${Math.round(shot.h / 3)}`);
  await page.press('#prompt', 'Enter');
  for (let i = 0; i < 2; i++) {
    await page.waitForSelector('.confirm-card:not(.answered) button', { timeout: 20000 });
    await page.locator('.confirm-card:not(.answered)').getByRole('button', { name: '本次都允许', exact: true }).click();
  }
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n && !document.querySelector('#transcript .msg.agent.streaming'), before, { timeout: 30000 });
  const r2 = await page.locator('#transcript .msg.agent').last().innerText();
  const m2 = mouse();
  check('智能体：看屏幕后点击指定位置，并拿到操作后的截图', /操作完成。已点击/.test(r2) && /当前屏幕截图/.test(r2) && Math.abs(m2.x - scr[0] / 2) <= 2 && Math.abs(m2.y - scr[1] / 3) <= 2, `${r2.replace(/\n/g, ' ').slice(-120)} ${JSON.stringify(m2)}`);
  check('电脑操作结束后贾维斯窗口回到前台', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
}

// —— 桌面背景 + 主动问好
{
  await page.evaluate(() => window.jarvisDesktop.invoke('setWallpaper', { on: true }));
  let wpPage = null;
  for (let i = 0; i < 50 && !wpPage; i++) { wpPage = app.windows().find((w) => w.url().includes('wallpaper.html')); if (!wpPage) await page.waitForTimeout(200); }
  await wpPage.waitForFunction(() => window.__wallpaper?.stage?.stats.frames > 3, null, { timeout: 30000 }).catch(() => {});
  check('桌面背景在渲染粒子体', await wpPage.evaluate(() => window.__wallpaper.stage.stats.frames > 3));
  const wpInfo = await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows().find((x) => /wallpaper/.test(x.webContents.getURL())); const b = w?.getBounds(); const d = screen.getPrimaryDisplay().bounds; return w ? { focusable: w.isFocusable(), visible: w.isVisible(), full: b.width === d.width && b.height === d.height } : null; });
  check('开启桌面背景：出现铺满屏幕、不抢焦点的背景窗口', wpInfo?.visible && wpInfo.full && !wpInfo.focusable, JSON.stringify(wpInfo));
  const hb = await page.locator('#transcript .msg.agent').count();
  await page.evaluate(() => window.jarvisDesktop.invoke('presenceTest', { awayMs: 2 * 3600_000 }));
  await page.waitForFunction((n) => document.querySelectorAll('#transcript .msg.agent').length > n, hb, { timeout: 10000 }).catch(() => {});
  const greet = await page.locator('#transcript .msg.agent').last().innerText();
  check('离开后回来：主窗口主动问好', /主动问候/.test(greet), greet.replace(/\n/g, ' ').slice(0, 80));
  await wpPage.waitForFunction(() => !document.querySelector('#wp-say').hidden, null, { timeout: 5000 }).catch(() => {});
  check('问候同步显示在桌面背景上', (await wpPage.textContent('#wp-say')).length > 4, await wpPage.textContent('#wp-say'));
  await page.evaluate(() => window.__jarvis.send('帮我写一个网页'));
  await wpPage.waitForFunction(() => window.__wallpaper.forms.includes('lattice'), null, { timeout: 15000 }).catch(() => {});
  check('主窗口干活时，桌面背景上的粒子体同步变形', await wpPage.evaluate(() => window.__wallpaper.forms.includes('lattice')), await wpPage.evaluate(() => window.__wallpaper.forms.join(' → ')));
  await wpPage.screenshot({ path: `${OUT}/desktop-wallpaper.png` });
  await page.waitForFunction(() => !document.querySelector('#transcript .msg.agent.streaming'), null, { timeout: 30000 });
  await page.evaluate(() => window.jarvisDesktop.invoke('setWallpaper', { on: false }));
  check('关闭桌面背景', !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => /wallpaper/.test(w.webContents.getURL())))));
}

// —— 操作习惯学习（开关 + 用模拟采样验证总结、写入记忆、用于问候）
{
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  check('设置里有“学习我的操作习惯”（默认关闭）', await page.isVisible('#row-habits') && !(await page.isChecked('#set-habits')));
  await page.check('#set-habits');
  await page.waitForTimeout(300);
  check('打开后主进程开始采样', (await page.evaluate(() => window.jarvisDesktop.invoke('habitTrackingState'))).on);
  await page.evaluate(async () => {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    for (let d = 1; d <= 4; d++) {
      const base = day0.getTime() - d * 86400000;
      for (let m = 9 * 60; m < 11 * 60; m++) await window.__jarvis.habits.record({ app: 'Code.exe', ts: base + m * 60000 });
    }
    await window.__jarvis.habits.flush();
    return window.__jarvis.memorizeHabits({ manual: true });
  });
  await page.waitForTimeout(300);
  const hl = await page.locator('#habit-insights li').allTextContents();
  check('观察几天后总结出习惯', hl.some((t) => /通常 09:00 左右开始用电脑/.test(t)) && hl.some((t) => /先打开 VS Code/.test(t)), hl.join(' | '));
  await page.evaluate(() => window.__jarvis.showPanel('mind'));
  await page.waitForTimeout(300);
  check('习惯写进记忆（分类“习惯”）', /习惯/.test(await page.textContent('[data-pane="mind"]')) && /VS Code/.test(await page.textContent('[data-pane="mind"]')));
  await page.uncheck('#set-habits').catch(async () => { await page.evaluate(() => window.__jarvis.showPanel('settings')); await page.uncheck('#set-habits'); });
  await page.waitForTimeout(300);
  check('关闭后停止采样', !(await page.evaluate(() => window.jarvisDesktop.invoke('habitTrackingState'))).on);
}

// —— MCP：在界面里添加本机 stdio 服务 → 智能体调用（先确认）
await page.click('.wb-nav [data-destination=connections]'); // 工作台：MCP 在“连接应用”页
await page.waitForSelector('#mcp-body:not([hidden])', { timeout: 10000 });
await page.locator('#mcp-presets button', { hasText: '自定义' }).click();
await page.fill('#mcp-form [name=name]', 'echo');
await page.fill('#mcp-form [name=command]', process.execPath);
await page.fill('#mcp-form [name=args]', `"${path.resolve(here, 'fixtures/mcp-echo.mjs')}"`);
await page.click('#mcp-form button[type=submit]');
await page.waitForFunction(() => /已连接/.test(document.querySelector('#mcp-list')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
check('界面添加 MCP 服务并连接', /已连接/.test(await page.textContent('#mcp-list')) && /3 个工具/.test(await page.textContent('#mcp-list')), (await page.textContent('#mcp-list')).slice(0, 120));
check('MCP 配置保存到应用数据目录', fs.existsSync(path.join(HOME, '.jarvis', 'mcp.json')));
await page.screenshot({ path: `${OUT}/desktop-mcp.png` });

r = await ask('用 MCP 的 echo 工具 你好贾维斯', { approve: '允许' });
check('智能体调用 MCP 工具（确认后）', /MCP 工具返回：回显：你好贾维斯/.test(r), r.replace(/\n/g, ' ').slice(-300));
r = await ask('用 MCP 的 add 工具 算 2 加 40', { approve: '允许' });
check('未设“自动允许”的 MCP 服务每次都先确认，然后返回结果', /MCP 工具返回：42/.test(r), r.slice(-60));

check('无页面错误', errors.length === 0, errors.join(' | '));
await app.close();
fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
