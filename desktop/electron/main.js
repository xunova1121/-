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
import { app, BrowserWindow, Menu, shell, dialog, safeStorage } from 'electron';
import path from 'node:path';
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

async function startServer() {
  // 必须赶在保险箱第一次读盘之前接上 DPAPI，否则会先用 AES 兜底方案打开
  attachSafeStorage(safeStorage);
  serverInfo = await listen();
  return serverInfo;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(DATA_DIR)
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

  await mainWindow.loadURL(serverInfo.url);
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
