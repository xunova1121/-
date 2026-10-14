/**
 * 贾维斯桌面版（Electron 主进程）
 *
 *   - 在进程内启动本机网关（模型转发、MCP、系统指标），窗口加载 http://127.0.0.1:18787
 *   - 通过 preload 给页面提供“操作电脑”的能力（文件、打开程序、运行命令、截屏、剪贴板、通知）
 *   - 托盘常驻、全局快捷键 Ctrl/⌘+Shift+J 随时呼出、开机自启
 */
import { app, BrowserWindow, ipcMain, shell, clipboard, Notification, desktopCapturer, screen, Tray, Menu, nativeImage, globalShortcut, session, systemPreferences, powerMonitor } from 'electron';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOps, userPaths } from './ops.mjs';
import { createBackups } from './backups.mjs';
import { createControl, STOP_HOTKEY } from './control.mjs';
import { createWallpaper } from './wallpaper.mjs';
import { createPresence } from './presence.mjs';
import { createActivity } from './activity.mjs';
import { createUpdater, RELEASES_URL } from './updater.mjs';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(here, 'bundle');
const ICON = path.join(here, 'build', 'icon.png');
const PORTS = Array.from({ length: 10 }, (_, i) => 18787 + i);
const HOTKEY = 'CommandOrControl+Shift+J';
const TEST = process.env.JARVIS_DESKTOP_TEST === '1';

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.jarvis.desktop');
// 数据（MCP 配置等）放在应用数据目录；测试时可用 JARVIS_HOME 指定
process.env.JARVIS_HOME ||= app.getPath('userData');

/** 从 Finder / 开始菜单启动时 PATH 不完整，npx、uvx 找不到：读取登录 shell 的 PATH */
function loginShellPath() {
  if (process.platform === 'win32') return '';
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s" "$PATH"'], { timeout: 4000, encoding: 'utf8' });
    return out.split('__PATH__').pop().trim();
  } catch {
    return ['/opt/homebrew/bin', '/usr/local/bin', path.join(app.getPath('home'), '.local/bin')].join(':');
  }
}

let win = null;
let tray = null;
let origin = '';
let quitting = false;
let mcp = null;
let server = null;

async function startGateway() {
  const extraPath = loginShellPath();
  if (extraPath) process.env.PATH = [process.env.PATH, extraPath].filter(Boolean).join(path.delimiter);
  const { createServer } = await import(pathToUrl(path.join(APP_DIR, 'server', 'server.mjs')));
  const { createMcpManager } = await import(pathToUrl(path.join(APP_DIR, 'server', 'mcp.mjs')));
  mcp = createMcpManager({ configPath: path.join(process.env.JARVIS_HOME, 'mcp.json'), log: (m) => console.log(m) });
  server = createServer({ staticDir: path.join(APP_DIR, 'dist'), mcp });
  for (const port of PORTS) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      origin = `http://127.0.0.1:${port}`;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!origin) throw new Error('端口 18787–18796 都被占用了');
  mcp.startAll();
}
const pathToUrl = (p) => pathToFileURL(p).href;

// ---------------------------------------------------------------- 电脑操作
// 改文件前自动备份：存在数据文件夹的 backups 里，30 天 / 500 MB 以内（见 backups.mjs）
const backups = createBackups({ dir: path.join(process.env.JARVIS_HOME, 'backups'), trash: (p) => shell.trashItem(p) });
backups.prune().catch(() => {});
const ops = createOps({
  backups,
  shell,
  clipboard,
  notify: (title, body) => new Notification({ title, body, icon: ICON }).show(),
  async screenshot() {
    const d = screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    if (!src) throw new Error('无法截屏（macOS 需要在“系统设置 → 隐私与安全性 → 屏幕录制”里允许贾维斯）');
    return { base64: src.thumbnail.toPNG().toString('base64'), ...src.thumbnail.getSize() };
  }
});

// ---------------------------------------------------------------- 鼠标键盘控制
const control = createControl({ screen, desktopCapturer, clipboard, systemPreferences, getWin: () => win });
function stopControl() {
  control.stop();
  control.end();
  win?.webContents.send('jarvis:stop');
}
Object.assign(ops, {
  async controlBegin() {
    control.begin();
    if (!globalShortcut.isRegistered(STOP_HOTKEY)) globalShortcut.register(STOP_HOTKEY, stopControl);
    return { stopHotkey: process.platform === 'darwin' ? 'Cmd+Option+Q' : 'Ctrl+Alt+Q' };
  },
  controlLook: () => control.look(),
  controlAct: (a) => control.act(a),
  async controlEnd() {
    control.end();
    if (globalShortcut.isRegistered(STOP_HOTKEY)) globalShortcut.unregister(STOP_HOTKEY);
    return { ok: true };
  }
});

// ---------------------------------------------------------------- 桌面背景 + 在场检测
const prefsFile = () => path.join(process.env.JARVIS_HOME, 'desktop.json');
function readPrefs() {
  for (const f of [prefsFile(), `${prefsFile()}.bak`]) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 没有或损坏：试备份 */ } }
  return {};
}
function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  // 先写临时文件再替换，替换前留一份能用的备份：写到一半断电不会把设置弄坏
  try {
    const f = prefsFile(), tmp = `${f}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    try { JSON.parse(fs.readFileSync(f, 'utf8')); fs.copyFileSync(f, `${f}.bak`); } catch { /* 还没有或已损坏 */ }
    fs.renameSync(tmp, f);
  } catch (e) { console.warn(e); }
  return next;
}
let wallpaper = null;
function setWallpaper(on) {
  writePrefs({ wallpaper: on });
  if (on) wallpaper.show(); else wallpaper.close();
  tray?.setContextMenu(trayMenu?.());
  return { on: wallpaper.open };
}
const presence = createPresence({
  powerMonitor,
  onBack: (info) => win?.webContents.send('jarvis:presence', info)
});
const activity = createActivity({ powerMonitor, onSample: (sample) => win?.webContents.send('jarvis:activity', sample) });
function setHabits(on) {
  writePrefs({ habits: on });
  if (on) activity.start(); else activity.stop();
  return { on: activity.on };
}
// 自动更新（只在安装好的正式包里检查）
const updater = await createUpdater({ app, send: (s) => win?.webContents.send('jarvis:update', s), onBeforeInstall: () => { quitting = true; } });
Object.assign(ops, {
  updateState: () => ({ ...updater.state, auto: updater.auto, packaged: app.isPackaged }),
  async updateCheck() { if (!app.isPackaged) return { state: 'dev' }; await updater.check(); return updater.state; },
  updateInstall: () => ({ ok: updater.install() }),
  openReleases: () => { shell.openExternal(RELEASES_URL); return { ok: true }; },
  setHabitTracking: ({ on }) => setHabits(Boolean(on)),
  habitTrackingState: () => ({ on: activity.on }),
  setWallpaper: ({ on }) => setWallpaper(Boolean(on)),
  wallpaperState: () => ({ on: Boolean(wallpaper?.open), mode: wallpaper?.mode ?? '' }),
  /** 主窗口把粒子体的状态 / 要说的话同步到桌面背景 */
  async wallpaperEvent(payload) { wallpaper?.send(payload); return { ok: true }; },
  /** 测试用：模拟“离开一段时间后回来” */
  async presenceTest({ awayMs = 3600000 } = {}) { if (!TEST) throw new Error('仅测试模式可用'); win?.webContents.send('jarvis:presence', { awayMs, reason: 'test' }); return { ok: true }; }
});

const fromOurPage = (e) => Boolean(origin) && String(e.senderFrame?.url || '').startsWith(`${origin}/`);
ipcMain.handle('jarvis:desktop', async (e, op, args) => {
  if (!fromOurPage(e)) return { ok: false, error: '拒绝：调用来源不是贾维斯页面' };
  const fn = Object.hasOwn(ops, op) ? ops[op] : null;
  if (!fn) return { ok: false, error: `未知操作：${op}` };
  try { return { ok: true, value: await fn(args ?? {}) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
});
ipcMain.on('jarvis:info', (e) => {
  e.returnValue = { platform: process.platform, version: app.getVersion(), paths: userPaths(app.getPath('home')) };
});
ipcMain.handle('jarvis:window', (e, action, value) => {
  if (!fromOurPage(e) || !win) return false;
  if (action === 'alwaysOnTop') win.setAlwaysOnTop(Boolean(value), 'floating');
  if (action === 'hide') win.hide();
  // 右上角系统按钮（最小化 / 最大化 / 关闭）的底色和高度跟随页面顶栏（明暗主题切换时页面会发过来）
  if (action === 'titleBar' && process.platform !== 'darwin' && value && typeof win.setTitleBarOverlay === 'function') {
    const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : null);
    const color = hex(value.color);
    const symbolColor = hex(value.symbolColor);
    const height = Math.round(Number(value.height));
    if (color && symbolColor) win.setTitleBarOverlay({ color, symbolColor, ...(height >= 28 && height <= 120 && { height }) });
    if (color) win.setBackgroundColor(color);
  }
  return true;
});

// ---------------------------------------------------------------- 窗口、托盘、快捷键
function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '贾维斯',
    icon: ICON,
    backgroundColor: '#03070d',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: mac ? undefined : { color: '#03070d', symbolColor: '#9fb3c4', height: 56 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  win.loadURL(`${origin}/`);
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });

  // 页面里的外部链接用系统浏览器打开；同源 / blob（工作区预览）在新窗口打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${origin}/`) || url.startsWith('blob:') || url === 'about:blank') return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${origin}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  let hintShown = false;
  win.on('close', (e) => {
    if (quitting || TEST) return;
    e.preventDefault();
    win.hide();
    if (!hintShown && Notification.isSupported()) {
      hintShown = true;
      new Notification({ title: '贾维斯仍在后台运行', body: `按 ${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Shift+J 随时呼出，或点托盘图标。`, icon: ICON }).show();
    }
  });
}

function summon() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) { win.hide(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('jarvis:summon');
}

let trayMenu = null;
function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip('贾维斯');
  const menu = () => Menu.buildFromTemplate([
    { label: '呼出贾维斯', accelerator: HOTKEY, click: summon },
    { type: 'separator' },
    { label: '桌面背景模式', type: 'checkbox', checked: Boolean(wallpaper?.open), click: (i) => setWallpaper(i.checked) },
    { label: '检查更新', click: () => { updater.check(); summon(); } },
    { label: '开机时自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }); } },
    { label: '打开数据文件夹', click: () => shell.openPath(process.env.JARVIS_HOME) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
  trayMenu = menu;
  tray.setContextMenu(menu());
  tray.on('click', summon);
}

function setMenu() {
  if (process.platform === 'darwin') {
    // macOS 需要应用菜单，复制 / 粘贴等快捷键才能用
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '贾维斯', submenu: [{ role: 'about', label: '关于贾维斯' }, { type: 'separator' }, { role: 'hide', label: '隐藏' }, { type: 'separator' }, { label: '退出', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

app.on('second-instance', () => summon());
app.on('activate', () => summon());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  control.close();
  presence.stop();
  activity.stop();
  updater.stop();
  wallpaper?.close();
  globalShortcut.unregisterAll();
  mcp?.closeAll();
  server?.close();
});

app.whenReady().then(async () => {
  // 只给自己的页面开放麦克风、摄像头、通知、剪贴板写入、文件夹访问
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && String(details.requestingUrl || wc.getURL()).startsWith(`${origin}/`));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => allowed.has(permission) && requestingOrigin === origin);

  try {
    await startGateway();
  } catch (e) {
    const { dialog } = await import('electron');
    dialog.showErrorBox('贾维斯启动失败', e.message);
    app.exit(1);
    return;
  }
  setMenu();
  createWindow();
  wallpaper = createWallpaper({ BrowserWindow, screen, url: `${origin}/wallpaper.html`, preload: path.join(here, 'preload.cjs'), icon: ICON, onLog: (m) => console.log(m) });
  if (readPrefs().wallpaper) wallpaper.show();
  if (readPrefs().habits) activity.start();
  presence.start();
  if (!TEST) updater.start();
  if (!TEST) {
    createTray();
    if (!globalShortcut.register(HOTKEY, summon)) console.warn(`快捷键 ${HOTKEY} 已被其他程序占用`);
  }
});

app.on('window-all-closed', () => {
  // 关闭窗口只是隐藏到托盘；测试模式直接退出
  if (TEST) app.quit();
});


