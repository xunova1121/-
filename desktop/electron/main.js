/**
 * Electron 主进程。
 *
 * 本地服务跑在主进程里（不另起子进程）：省一个进程、省一次端口协商，
 * 关窗口时服务跟着走，不会留下孤儿进程占着 5178 端口 ——
 * 这是本地工具类应用最常见的投诉之一。
 *
 * 另一个作用是把 Windows DPAPI（safeStorage）接进保险箱：
 * 在桌面应用里，密钥的加密密钥由操作系统托管并绑定当前用户账户，
 * 比裸 Node 模式下自管一个 key 文件安全一档。
 */
import { app, BrowserWindow, Menu, shell, dialog, safeStorage, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 一律用静态 import。
// 早期版本这里写的是 await import(path.join(here, '../core/vault.js'))，
// 在 Linux 上跑得好好的，到 Windows 上一启动就炸：
//   Only URLs with a scheme in: file, data, node, and electron are supported…
//   Received protocol 'd:'
// 原因是 path.join 在 Windows 上产出 `D:\...\core\vault.js`，
// 而 ESM 的动态 import 在 Windows 上只认 file:// URL，不认盘符路径
// （Linux 下 `/` 开头恰好是合法说明符，所以这个坑只在 Windows 现形）。
// 相对说明符没有这个问题，也不需要拼路径 —— 直接静态导入最稳。
import { attachSafeStorage } from '../core/vault.js';
import { attachElectronFetch } from '../core/http-client.js';
import { listen } from '../core/server.js';
import { DATA_DIR } from '../core/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverInfo = null;

// 同一时间只允许一个实例：两个实例会抢同一份项目文件，写坏了很难查
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * 连远端服务器，还是在本机跑引擎。
 *
 * ── 这是"三端打通"真正的那一步 ──
 *
 * 账号密码解决的是"谁能进"，不解决"数据在哪"。电脑上一份、服务器上一份，
 * 加了账号也还是两份互不相干的数据 —— 在电脑上写的剧本，手机上照样看不到。
 *
 * 真正打通只有一条路：**让服务器成为唯一的数据源**。所以这个壳子多了一种形态 ——
 * 不在本机起引擎，而是把窗口指向那台服务器。这时候它和手机、和浏览器
 * 是同一个客户端，看到的是同一份数据，因为压根只有一份。
 *
 * 本机模式一个字没动：不想租服务器的人不该为这个功能付出任何代价。
 */
const REMOTE_FILE = path.join(app.getPath('userData'), 'remote.json');

// cap:remote-engine
function remoteConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8'));
    const url = String(raw.url || '').trim().replace(/\/+$/, '');
    return url ? { url } : null;
  } catch {
    return null;
  }
}

function saveRemote(url) {
  fs.mkdirSync(path.dirname(REMOTE_FILE), { recursive: true });
  if (!url) {
    try {
      fs.unlinkSync(REMOTE_FILE);
    } catch {
      /* 本来就没有 */
    }
    return;
  }
  fs.writeFileSync(REMOTE_FILE, JSON.stringify({ url: url.replace(/\/+$/, '') }, null, 2), 'utf8');
}

async function startServer() {
  const remote = remoteConfig();
  if (remote) {
    /**
     * ⚠ 连远端时**不起本地引擎**。
     *
     * 起了会有两个后果，都不轻：一是白占端口和内存；二是更麻烦的 ——
     * 本地那份和远端那份会各自有一套项目数据，而窗口里看到的是远端的，
     * 于是"我明明存过"这类问题会变得完全无法解释。
     * 要么全在这儿，要么全在那儿，不能一半一半。
     */
    serverInfo = { url: remote.url, port: 0, remote: true };
    return serverInfo;
  }
  // 必须赶在保险箱第一次读盘之前接上 DPAPI，否则会先用 AES 兜底方案打开
  attachSafeStorage(safeStorage);
  // Chromium 的网络栈会读系统代理；用不用由「设置 → 使用系统代理」决定
  attachElectronFetch((url, init) => net.fetch(url, init));
  serverInfo = await listen();
  return serverInfo;
}

/** 问一句要连哪台服务器。填空 = 回到本机模式 */
async function askRemote() {
  const current = remoteConfig()?.url || '';
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['连接服务器…', '在本机跑（默认）', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '引擎在哪儿跑',
    message: current ? `现在连的是 ${current}` : '现在是在本机跑',
    detail:
      '连服务器：项目、密钥、成片都在那台机器上，手机和电脑看到的是同一份数据，'
      + '关掉电脑也不影响它继续跑。\n\n'
      + '在本机跑：数据全在这台电脑上，不需要服务器，但手机得和电脑在同一个 Wi-Fi。\n\n'
      + '⚠ 两种模式的数据是分开的 —— 切过去看不到这边的项目，切回来也一样。',
    checkboxLabel: '换模式后重启应用',
    checkboxChecked: true
  });
  if (response === 2) return;

  if (response === 1) {
    saveRemote('');
  } else {
    const url = await promptRemoteUrl(current);
    if (url === null) return;
    saveRemote(url);
  }
  if (checkboxChecked) {
    app.relaunch();
    app.exit(0);
  }
}

/**
 * 问一个地址。
 *
 * ⚠ **不能用 window.prompt** —— Electron 不实现它，调用会直接抛
 * "prompt() is and will not be supported"。第一版就是这么写的，
 * 结果是点了菜单什么都不发生，而且控制台之外看不到任何线索。
 *
 * 也不另开一个窗口 + 一套 IPC：为一个输入框拉一整套管道太重，
 * 而且那套管道以后每次改都要动主进程、预加载、页面三处。
 *
 * 现在的做法是往当前页面注入一个浮层，等它自己 resolve ——
 * executeJavaScript 会把 Promise 的结果带回来。整件事只在 main.js 里，
 * 页面那边一个字都不用改。
 */
async function promptRemoteUrl(current) {
  const script = `
    new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.55);font:14px/1.6 system-ui,sans-serif';
      const card = document.createElement('div');
      card.style.cssText = 'width:min(520px,90vw);padding:22px;border-radius:12px;' +
        'background:#1D1913;color:#EFE8DC;border:1px solid #352D23';
      card.innerHTML =
        '<div style="font-size:16px;font-weight:600;margin-bottom:6px">连接到服务器</div>' +
        '<div style="color:#A99B86;font-size:12.5px;margin-bottom:14px">' +
        '填你部署的那个地址。留空并确定 = 回到本机模式。</div>';
      const input = document.createElement('input');
      input.value = ${JSON.stringify(current || '')};
      input.placeholder = 'https://47.243.29.184.nip.io';
      input.style.cssText = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid #352D23;' +
        'background:#262019;color:#EFE8DC;font:inherit';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px';
      const mk = (text, primary) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.style.cssText = 'padding:8px 16px;border-radius:8px;font:inherit;cursor:pointer;border:1px solid #352D23;' +
          (primary ? 'background:#3E7CB1;color:#fff;border-color:#3E7CB1' : 'background:#262019;color:#EFE8DC');
        return b;
      };
      const cancel = mk('取消', false);
      const ok = mk('确定', true);
      cancel.onclick = () => { box.remove(); resolve(null); };
      ok.onclick = () => { const v = input.value.trim(); box.remove(); resolve(v); };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') ok.click();
        if (e.key === 'Escape') cancel.click();
      };
      row.append(cancel, ok);
      card.append(input, row);
      box.append(card);
      document.body.append(box);
      input.focus();
      input.select();
    })
  `;
  const got = await mainWindow.webContents.executeJavaScript(script, true).catch(() => null);
  if (got === null) return null;
  const url = String(got).trim();
  if (!url) return '';
  if (!/^https?:\/\//.test(url)) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      message: '地址要带 http:// 或 https://',
      detail: `你填的是：${url}`
    });
    return null;
  }
  return url;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          // 连远端时本机数据目录是空的，菜单里说清楚免得人去那儿找项目
          label: serverInfo?.remote ? '打开本机数据目录（当前连的是服务器）' : '打开数据目录',
          click: () => shell.openPath(DATA_DIR)
        },
        {
          label: '引擎在哪儿跑…',
          click: () => askRemote()
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于未来创梦',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '未来创梦',
              detail:
                `AI 短剧工作台\n\n` +
                `本地服务：${serverInfo?.url || '未启动'}\n` +
                `Electron ${process.versions.electron} · Node ${process.versions.node}\n\n` +
                `所有数据留在本机，密钥由 Windows DPAPI 加密保存。`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#16130F', // 和界面底色一致，避免启动时闪一下白屏
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      // 预加载脚本必须是 CJS：package.json 里 type=module，同名 .js 会被当 ESM 解析
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 站外链接一律交给系统浏览器，不在应用里开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverInfo.url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  /**
   * 连远端时窗口标题要写出来。
   *
   * 两种模式的界面**长得一模一样**，而数据是分开的 —— 分不清自己连的是哪边，
   * 就一定会出现"我明明存过"这种查不清的问题。标题栏是最便宜的一条提示。
   */
  if (serverInfo.remote) {
    mainWindow.setTitle(`未来创梦 —— ${serverInfo.url}`);
    mainWindow.on('page-title-updated', (e) => e.preventDefault());
  }

  await mainWindow.loadURL(serverInfo.url).catch(async (err) => {
    // 远端连不上时别扔一张 Chromium 的错误页 —— 那上面没有一句能照着做的话
    if (!serverInfo.remote) throw err;
    await mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="background:#16130f;color:#b6ab9b;font:15px/1.7 sans-serif;padding:60px 40px">
           <h2 style="color:#f2ece3">连不上 ${serverInfo.url}</h2>
           <p>检查三件事：服务器是不是开着（<code>docker compose ps</code>）；
           地址有没有写错；这台电脑能不能上网。</p>
           <p style="color:#7d7365">菜单「文件 → 引擎在哪儿跑…」可以换地址，或者切回本机模式。</p>
         </body>`
      )}`
    );
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

/**
 * 冒烟自检：`electron . --smoke`
 *
 * 只把主进程和本地服务拉起来，探一下 /api/health 就退出，不开窗口。
 * 加这个是因为吃过一次亏 —— 主进程里一个 Windows 专属的 ESM 加载错误
 * （见文件顶部注释）躲过了全部 65 项单元自检，直到用户双击 exe 才炸出来。
 * 单元测试测不到"Electron 主进程能不能起来"这件事，只有真的跑一次才行。
 */
async function runSmoke() {
  try {
    const { url } = await startServer();
    const res = await fetch(`${url}/api/health`);
    const health = await res.json();
    if (!res.ok || !health.ok) throw new Error(`健康检查返回 ${res.status}`);
    console.log(`[smoke] 通过 —— 服务 ${url}，凭据后端 ${health.vaultBackend}，Electron ${process.versions.electron}`);
    app.exit(0);
  } catch (err) {
    console.error(`[smoke] 失败：${err.stack || err.message}`);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  if (process.argv.includes('--smoke')) return runSmoke();

  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('启动失败', `本地服务没能起来：\n\n${err.message}`);
    app.quit();
    return;
  }
  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  return undefined;
});

app.on('window-all-closed', () => {
  serverInfo?.server?.close();
  if (process.platform !== 'darwin') app.quit();
});
